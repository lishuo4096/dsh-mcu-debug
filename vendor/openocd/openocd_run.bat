@echo off
openocd -s ./scripts -f ./scripts/interface/jlink.cfg -f ./scripts/target/py32f031.cfg
pause