@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo  CROCANTI CHICKEN - SINCRONIZACION MANUAL CONTRA NEON
echo ============================================================
echo.

rem 1. Verificar si el backend ya responde
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    echo [1/3] Iniciando backend en una ventana nueva...
    start "Crocanti Backend" cmd /k "node index.js"
    echo      Esperando a que el servidor escuche en el puerto 3000...
    powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 1 | Out-Null; $ok=$true; break } catch { Start-Sleep -Seconds 1 } }; if(-not $ok){ exit 1 }"
    if errorlevel 1 (
        echo [ERROR] El backend no respondio. Revisa la otra ventana.
        pause
        exit /b 1
    )
) else (
    echo [1/3] El backend ya esta corriendo en http://127.0.0.1:3000
)

echo.
echo [2/3] Datos de acceso del administrador
set "ADMIN_CLAVE="
set /p "ADMIN_CLAVE=Clave de admin@crocanti.com: "
if not defined ADMIN_CLAVE (
    echo [ERROR] No escribiste la clave.
    pause
    exit /b 1
)

echo.
echo [3/3] Ejecutando prueba real INSERT / UPDATE / DELETE contra Neon...
echo.
call npm run probar-sync -- admin@crocanti.com
set "RESULTADO=%ERRORLEVEL%"
set "ADMIN_CLAVE="

echo.
if "%RESULTADO%"=="0" (
    echo Prueba de sincronizacion completada correctamente.
) else (
    echo La prueba fallo. Revisa el mensaje anterior.
)
echo.
pause
exit /b %RESULTADO%
