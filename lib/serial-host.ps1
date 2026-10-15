<#
  dsh-mcu-debug 串口宿主（常驻进程）

  为什么要有这么一个东西：串口是**独占资源**，而且「打开-收发-关闭」必须落在
  同一个进程里才有意义 —— Node 没有内置串口 API，每次起一个新 PowerShell 就等于
  每次都要重新打开一次口（还会把 DTR 重新拉一遍，把目标板复位）。

  所以：一个常驻进程，stdin 收 JSON 命令、stdout 回 JSON 结果，串口句柄留在它手里。

  ## 协议（一行一个 JSON）

    请求  {"id":"1","op":"open","port":"COM21","baud":115200}
    响应  {"id":"1","ok":true,"port":"COM21","baud":115200}

    op 一览：
      list        列出本宿主当前打开的口
      open        port/baud/dataBits/parity/stopBits/dtr/rts
      write       text（或 hex 十六进制串）
      read        timeoutMs / maxBytes —— 到点就返回已收到的部分，不会一直挂着
      readline    timeoutMs / maxLineBytes —— 读到换行或超时
      flush       清空输入缓冲
      pins        读回 DTR/RTS/CTS/DSR 状态
      setpins     dtr/rts
      close       关掉一个口（port 省略则关全部）
      ping
      quit

  ## 行为约定

  - **不自动打开任何口**。没 `open` 就 `write`/`read` 会明确报错。
  - 默认 DTR=false、RTS=false。很多 USB 转串口板子把 DTR 接到目标 RESET，
    默认拉高会把目标按住不放 —— 这种「打开了但什么都没收到」极难排查。
  - 读走 `ReadTimeout`，到点抛 TimeoutException → 转成 `ok:true, bytes:0`，
    而不是错误。**「没数据」不是故障。**
  - 空转超过 idleMinutes 分钟且没有任何口打开 → 自己退出，不留残留进程。
#>

[CmdletBinding()]
param(
  [int] $IdleMinutes = 20
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# stdout 必须是干净的一行一个 JSON —— 任何多余输出都会破坏协议
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:Out = [Console]::Out

function Write-Reply {
  param([hashtable] $Payload)
  $script:Out.WriteLine(($Payload | ConvertTo-Json -Depth 6 -Compress))
  $script:Out.Flush()
}

function Write-Ok {
  param([string] $Id, [hashtable] $Extra = @{})
  $d = @{ id = $Id; ok = $true }
  foreach ($k in $Extra.Keys) { $d[$k] = $Extra[$k] }
  Write-Reply $d
}

function Write-Err {
  param([string] $Id, [string] $Message, [string] $Code = 'error')
  Write-Reply @{ id = $Id; ok = $false; code = $Code; error = $Message }
}

# ---------------------------------------------------------------- 串口类型加载

$script:SerialOk = $false
$script:SerialWhy = ''
try {
  Add-Type -AssemblyName System.IO.Ports -ErrorAction Stop
  $script:SerialOk = $true
} catch {
  try {
    # .NET Framework（Windows PowerShell 5.1）里它在 System.dll 中
    $null = [System.IO.Ports.SerialPort]
    $script:SerialOk = $true
  } catch {
    $script:SerialWhy = $_.Exception.Message
  }
}
if (-not $script:SerialOk) {
  Write-Err '' "本机的 PowerShell 里没有 System.IO.Ports（$script:SerialWhy）。请用 Windows PowerShell 5.1 或安装 System.IO.Ports 包。" 'no-serial-port-type'
  exit 3
}

$script:Ports = @{}   # 口名 → SerialPort

$script:ParityMap = @{
  'none' = [System.IO.Ports.Parity]::None
  'odd' = [System.IO.Ports.Parity]::Odd
  'even' = [System.IO.Ports.Parity]::Even
  'mark' = [System.IO.Ports.Parity]::Mark
  'space' = [System.IO.Ports.Parity]::Space
}
$script:StopMap = @{
  '1' = [System.IO.Ports.StopBits]::One
  '1.5' = [System.IO.Ports.StopBits]::OnePointFive
  '2' = [System.IO.Ports.StopBits]::Two
}

function Get-PortOrThrow {
  param([string] $Port)
  $key = $Port.ToUpperInvariant()
  if (-not $script:Ports.ContainsKey($key)) {
    $open = if ($script:Ports.Count) { ($script:Ports.Keys -join ', ') } else { '(当前没有打开任何口)' }
    throw "口 $Port 没有在这个宿主里打开。已打开：$open"
  }
  return $script:Ports[$key]
}

function Convert-HexToBytes {
  param([string] $Hex)
  $clean = ($Hex -replace '[^0-9a-fA-F]', '')
  if ($clean.Length % 2 -ne 0) { throw "十六进制串长度必须是偶数：$Hex" }
  $bytes = New-Object 'byte[]' ($clean.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($clean.Substring($i * 2, 2), 16)
  }
  return $bytes
}

# ---------------------------------------------------------------- 主循环

$lastActivity = Get-Date

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }          # 父进程关了 stdin → 退出
  $line = $line.Trim()
  if (-not $line) { continue }

  $req = $null
  try {
    $req = $line | ConvertFrom-Json
  } catch {
    Write-Err '' "请求不是合法 JSON：$line" 'bad-json'
    continue
  }

  $id = [string] $req.id
  $op = [string] $req.op
  $lastActivity = Get-Date

  try {
    switch ($op) {

      'ping' {
        Write-Ok $id @{ pong = $true; open = @($script:Ports.Keys) }
      }

      'list' {
        $rows = @()
        foreach ($k in $script:Ports.Keys) {
          $sp = $script:Ports[$k]
          $rows += @{
            port = $k
            open = $sp.IsOpen
            baud = $sp.BaudRate
            dataBits = $sp.DataBits
            parity = [string] $sp.Parity
            stopBits = [string] $sp.StopBits
            encoding = $sp.Encoding.WebName
            dtr = $sp.DtrEnable
            rts = $sp.RtsEnable
            readTimeout = $sp.ReadTimeout
            writeTimeout = $sp.WriteTimeout
            bytesToRead = $(if ($sp.IsOpen) { try { $sp.BytesToRead } catch { -1 } } else { -1 })
          }
        }
        Write-Ok $id @{ open = $rows }
      }

      'open' {
        $portName = [string] $req.port
        if (-not $portName) { throw 'open 需要 port' }
        $key = $portName.ToUpperInvariant()

        if ($script:Ports.ContainsKey($key) -and $script:Ports[$key].IsOpen) {
          $sp0 = $script:Ports[$key]
          Write-Ok $id @{ port = $key; reused = $true; baud = $sp0.BaudRate }
          break
        }

        $sp = New-Object System.IO.Ports.SerialPort
        $sp.PortName = $portName
        $sp.BaudRate = if ($req.baud) { [int] $req.baud } else { 115200 }
        $sp.DataBits = if ($req.dataBits) { [int] $req.dataBits } else { 8 }
        $sp.Parity = if ($req.parity) { $script:ParityMap[[string] $req.parity] } else { [System.IO.Ports.Parity]::None }
        $sp.StopBits = if ($req.stopBits) { $script:StopMap[[string] $req.stopBits] } else { [System.IO.Ports.StopBits]::One }
        $sp.Handshake = [System.IO.Ports.Handshake]::None
        $sp.Encoding = [System.Text.UTF8Encoding]::new($false)
        $sp.ReadTimeout = if ($req.readTimeoutMs) { [int] $req.readTimeoutMs } else { 1500 }
        $sp.WriteTimeout = if ($req.writeTimeoutMs) { [int] $req.writeTimeoutMs } else { 3000 }
        $sp.NewLine = "`n"

        # 关键：默认**不**拉 DTR/RTS。很多板子把 DTR 接 RESET，默认拉高会把目标按住。
        $sp.DtrEnable = [bool] $req.dtr
        $sp.RtsEnable = [bool] $req.rts

        try {
          $sp.Open()
        } catch [System.UnauthorizedAccessException] {
          $sp.Dispose()
          throw "口 $portName 打不开：**被别的程序占着**（拒绝访问）。先把占用者关掉 —— IDE 的串口终端、厂商上位机、或上一次没收干净的会话。"
        } catch [System.IO.IOException] {
          $sp.Dispose()
          throw "口 $portName 不存在或已被拔出：$($_.Exception.Message)"
        }

        $script:Ports[$key] = $sp
        Write-Ok $id @{
          port = $key
          baud = $sp.BaudRate
          dataBits = $sp.DataBits
          parity = [string] $sp.Parity
          stopBits = [string] $sp.StopBits
          dtr = $sp.DtrEnable
          rts = $sp.RtsEnable
        }
      }

      'write' {
        $sp = Get-PortOrThrow ([string] $req.port)
        $bytes = $null
        if ($req.hex) {
          $bytes = Convert-HexToBytes ([string] $req.text)
        } else {
          $text = [string] $req.text
          if ($req.encoding -eq 'ascii') { $bytes = [System.Text.Encoding]::ASCII.GetBytes($text) }
          else { $bytes = $sp.Encoding.GetBytes($text) }
        }
        $sp.Write($bytes, 0, $bytes.Length)
        Write-Ok $id @{ port = $sp.PortName; wrote = $bytes.Length }
      }

      'read' {
        $sp = Get-PortOrThrow ([string] $req.port)
        $timeout = if ($req.timeoutMs) { [int] $req.timeoutMs } else { 1000 }
        $max = if ($req.maxBytes) { [int] $req.maxBytes } else { 65536 }
        $sp.ReadTimeout = $timeout

        $ms = New-Object System.IO.MemoryStream
        $buf = New-Object 'byte[]' 4096
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $started = $false
        while ($sw.ElapsedMilliseconds -lt $timeout -and $ms.Length -lt $max) {
          try {
            $n = $sp.Read($buf, 0, [Math]::Min(4096, $max - [int] $ms.Length))
            if ($n -gt 0) { $ms.Write($buf, 0, $n); $started = $true }
          } catch [TimeoutException] {
            if ($started) { break }      # 已经收到过东西，超时即视为「这段收完了」
            continue
          } catch [System.IO.IOException] {
            break
          }
        }
        $sw.Stop()
        $all = $ms.ToArray()
        $ms.Dispose()
        $utf8 = $sp.Encoding.GetString($all)
        $hex = ($all | ForEach-Object { $_.ToString('X2') }) -join ''
        Write-Ok $id @{
          port = $sp.PortName
          bytes = $all.Length
          text = $utf8
          hex = $hex
          waitedMs = $sw.ElapsedMilliseconds
          remaining = $(try { $sp.BytesToRead } catch { -1 })
        }
      }

      'readline' {
        $sp = Get-PortOrThrow ([string] $req.port)
        $timeout = if ($req.timeoutMs) { [int] $req.timeoutMs } else { 3000 }
        $maxLine = if ($req.maxLineBytes) { [int] $req.maxLineBytes } else { 4096 }
        $sp.ReadTimeout = 200
        $sb = New-Object System.Text.StringBuilder
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $buf = New-Object 'byte[]' 512
        $done = $false
        while (-not $done -and $sw.ElapsedMilliseconds -lt $timeout -and $sb.Length -lt $maxLine) {
          try {
            $n = $sp.Read($buf, 0, 512)
            if ($n -gt 0) {
              $chunk = $sp.Encoding.GetString($buf, 0, $n)
              [void] $sb.Append($chunk)
              if ($chunk -match "`n") { $done = $true }
            }
          } catch [TimeoutException] { continue } catch [System.IO.IOException] { break }
        }
        $sw.Stop()
        $text = $sb.ToString()
        Write-Ok $id @{
          port = $sp.PortName
          bytes = $text.Length
          text = $text
          complete = [bool] $done
          waitedMs = $sw.ElapsedMilliseconds
        }
      }

      'flush' {
        $sp = Get-PortOrThrow ([string] $req.port)
        $n = 0
        try { $n = $sp.BytesToRead } catch { }
        if ($n -gt 0) {
          $discard = New-Object 'byte[]' $n
          try { [void] $sp.Read($discard, 0, $n) } catch { }
        }
        Write-Ok $id @{ port = $sp.PortName; discarded = $n }
      }

      'pins' {
        $sp = Get-PortOrThrow ([string] $req.port)
        Write-Ok $id @{
          port = $sp.PortName
          dtr = $sp.DtrEnable
          rts = $sp.RtsEnable
          cts = $sp.CtsHolding
          dsr = $sp.DsrHolding
          cd = $sp.CDHolding
          breakState = $sp.BreakState
        }
      }

      'setpins' {
        $sp = Get-PortOrThrow ([string] $req.port)
        if ($null -ne $req.dtr) { $sp.DtrEnable = [bool] $req.dtr }
        if ($null -ne $req.rts) { $sp.RtsEnable = [bool] $req.rts }
        Write-Ok $id @{ port = $sp.PortName; dtr = $sp.DtrEnable; rts = $sp.RtsEnable }
      }

      'close' {
        $closed = @()
        if ($req.port) {
          $key = ([string] $req.port).ToUpperInvariant()
          if ($script:Ports.ContainsKey($key)) {
            try { $script:Ports[$key].Close() } catch { }
            $script:Ports[$key].Dispose()
            $script:Ports.Remove($key)
            $closed += $key
          }
        } else {
          foreach ($k in @($script:Ports.Keys)) {
            try { $script:Ports[$k].Close() } catch { }
            $script:Ports[$k].Dispose()
            $script:Ports.Remove($k)
            $closed += $k
          }
        }
        Write-Ok $id @{ closed = $closed; open = @($script:Ports.Keys) }
      }

      'quit' {
        foreach ($k in @($script:Ports.Keys)) {
          try { $script:Ports[$k].Close() } catch { }
          try { $script:Ports[$k].Dispose() } catch { }
        }
        $script:Ports.Clear()
        Write-Ok $id @{ bye = $true }
        exit 0
      }

      default {
        Write-Err $id "不认识的 op：$op" 'unknown-op'
      }
    }
  } catch {
    Write-Err $id $_.Exception.Message 'op-failed'
  }

  # 没有任何口开着、且空转很久 → 自己退，不留残留
  if ($script:Ports.Count -eq 0 -and ((Get-Date) - $lastActivity).TotalMinutes -gt $IdleMinutes) {
    exit 0
  }
}
