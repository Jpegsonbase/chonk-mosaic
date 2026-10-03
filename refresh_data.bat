@echo off
REM ==========================================================
REM  Chonk Mosaic - refresh the Chonk data
REM  1. Re-download your Chonk images into the images folder first
REM     (so they show everyone's current traits).
REM  2. Double-click this file.
REM  3. Upload the web\data folder and web\og.png to GitHub.
REM ==========================================================

cd /d "%~dp0"
set IMAGES=%~dp0..\images

echo.
echo Rebuilding Chonk data from %IMAGES% ...
echo.
python build_dataset.py --images "%IMAGES%" --out ..\web\data
if errorlevel 1 goto failed

echo.
echo Making the link preview image ...
python make_social_image.py
if errorlevel 1 goto failed

echo.
echo ==========================================================
echo  Done. Now upload these to your GitHub repo and commit:
echo    - the whole web\data folder
echo    - web\og.png
echo  The site's footer will show today's date as the save date.
echo ==========================================================
echo.
pause
exit /b 0

:failed
echo.
echo Something went wrong - see the message above.
pause
exit /b 1
