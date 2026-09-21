import os
import shutil
import subprocess
import sys


def main():
    print("=" * 60)
    print("     COMPILADOR RÁPIDO A .EXE - MOODLE TASK TRACKER")
    print("=" * 60)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)

    # 1. Instalar dependencias
    print("\n[1/3] Verificando dependencias...")
    reqs = ["customtkinter", "requests", "beautifulsoup4", "plyer", "pillow", "darkdetect", "pyinstaller"]
    cmd_install = [sys.executable, "-m", "pip", "install"] + reqs
    ret = subprocess.run(cmd_install).returncode
    if ret != 0:
        print("\n[ERROR] Falló la instalación de dependencias.")
        return ret

    # 2. Compilar con PyInstaller
    print("\n[2/3] Compilando con PyInstaller e icono integrado...")
    cmd_build = [
        "pyinstaller",
        "--noconsole",
        "--onefile",
        "--icon=icon.ico",
        "--add-data=icon.ico;.",
        "--add-data=icon.png;.",
        "--collect-all",
        "customtkinter",
        "--name=MoodleTracker",
        "--clean",
        "app.py",
    ]
    ret = subprocess.run(cmd_build).returncode
    if ret != 0:
        print("\n[ERROR] Falló la compilación de PyInstaller.")
        return ret

    # 3. Mover a la raíz
    print("\n[3/3] Moviendo MoodleTracker.exe a la raíz...")
    dist_exe = os.path.join(base_dir, "dist", "MoodleTracker.exe")
    target_exe = os.path.join(base_dir, "MoodleTracker.exe")
    if os.path.exists(dist_exe):
        shutil.copyfile(dist_exe, target_exe)
        print(f"[OK] Ejecutable generado exitosamente en:\n  -> {target_exe}")

    print("\n" + "=" * 60)
    print("  ¡COMPILACIÓN EXITOSA! Ya puedes ejecutar MoodleTracker.exe")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
