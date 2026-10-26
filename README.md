# Circle

Circle is a small multi-user social network demo served by a Windows PowerShell backend.

## Start the app

Requirements: Windows PowerShell 5.1 and the SQLite command-line program (`sqlite3.exe`) available on `PATH`. Video uploads also require FFmpeg and ffprobe on `PATH`; the server converts video to H.264 MP4 and stores audio as a synchronized MP3 sidecar for browser playback. The rest of the app works without FFmpeg.

From this folder, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1
```

Then open <http://127.0.0.1:8123/>. Use **Create account** to register another account. Accounts, settings, sessions, and posts are stored in `data\circle.db` and shared by accounts using this server.

Run the backend startup and database checks with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server.ps1 -Check
```

## Android app

The Android app is a lightweight Trusted Web Activity that opens the hosted Circle site in Chrome. A recent JDK, Android SDK Platform 35, and Android Build Tools 35 are required to build it.

From the `android` folder, build an installable debug APK with:

```powershell
.\gradlew.bat assembleDebug
```

The APK is created at `android\app\build\outputs\apk\debug\app-debug.apk`. The hosted site must serve `/.well-known/assetlinks.json` with the app's signing-certificate fingerprint for Chrome to open it full-screen.

## Security scope

Passwords are salted and hashed with PBKDF2-HMAC-SHA256. Session identifiers are random, stored as hashes in SQLite, and sent in HTTP-only, same-site cookies. The default server binds to `127.0.0.1` and is intended for local development only. Do not expose it to the internet or use real credentials without HTTPS, deployment hardening, backups, and an appropriately hosted application server.
