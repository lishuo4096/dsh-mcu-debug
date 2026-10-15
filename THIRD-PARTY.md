# 第三方组件说明

本仓库的 MIT 许可（见 [LICENSE](LICENSE)）**只覆盖本插件自身的源代码**。
随仓库再分发的第三方组件如下，各自的许可以其原文为准。

## vendor/openocd/ —— OpenOCD 0.12.0

- 上游：Open On-Chip Debugger，https://openocd.org/
- 许可：**GNU GPL v2**
- 说明：**原样再分发，未做任何修改**。之所以随仓库带上，是因为本插件的核心设计
  前提就是「用自带副本，绝不碰用户 IDE 里那份 openocd」（理由见
  [README](README.md) 的「为什么做这个」第 2 条）。带副本的代价是仓库约 24 MB，
  换来的是克隆下来就能用、且永远不会污染别人的工具链。
- 许可证文本完整保留在该目录内：`license-openocd.txt`、`license-libusb.txt`、
  `license-libusb-win32.txt`、`license-hidapi.txt`、`license-libftdi.txt`。
- 该目录下的文件同时被 `.gitattributes` 标记为 `linguist-vendored`，
  不出现在 GitHub 的语言统计与 diff 中。
