param(
  [int]$Port = 8123,
  [string]$HostName = "127.0.0.1",
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$script:DatabasePath = Join-Path $PSScriptRoot "data\circle.db"
$script:SqliteCommand = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
if (-not $script:SqliteCommand) {
  $script:SqliteCommand = Get-Command sqlite3 -ErrorAction SilentlyContinue
}
if (-not $script:SqliteCommand) {
  throw "SQLite was not found. Install SQLite and make sqlite3.exe available on PATH."
}
$script:SqlitePath = $script:SqliteCommand.Source
$script:FfmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if (-not $script:FfmpegCommand) {
  $script:FfmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
}
$script:FfprobeCommand = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
if (-not $script:FfprobeCommand) {
  $script:FfprobeCommand = Get-Command ffprobe -ErrorAction SilentlyContinue
}
$script:SessionCookieName = "circle_session"
$script:SessionLifetimeDays = 7
$script:PasswordIterations = 310000

function ConvertTo-SqlText([AllowNull()][string]$Value) {
  if ($null -eq $Value) { return "NULL" }
  return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-Database([string]$Query) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $script:SqlitePath
  $startInfo.Arguments = "-batch -json `"$script:DatabasePath`""
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Could not start SQLite." }
  $process.StandardInput.WriteLine("PRAGMA foreign_keys = ON;")
  $process.StandardInput.WriteLine($Query)
  $process.StandardInput.Close()
  $output = $process.StandardOutput.ReadToEnd()
  $errors = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "SQLite request failed: $errors"
  }
  if ([string]::IsNullOrWhiteSpace($output)) { return @() }
  $parsed = ConvertFrom-Json -InputObject $output
  foreach ($row in $parsed) {
    Write-Output -InputObject $row
  }
}

function Initialize-Database {
  $directory = Split-Path -Parent $script:DatabasePath
  if (-not (Test-Path $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  function Ensure-Column([string]$TableName, [string]$ColumnName, [string]$Definition) {
    $existing = @(Invoke-Database "PRAGMA table_info($TableName);")
    $hasColumn = $existing | Where-Object { $_.name -eq $ColumnName }
    if (-not $hasColumn) {
      Invoke-Database "ALTER TABLE $TableName ADD COLUMN $ColumnName $Definition;" | Out-Null
    }
  }

  $schema = @"
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  profile_photo TEXT,
  about_me TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'friends',
  email_notifications INTEGER NOT NULL DEFAULT 1,
  product_updates INTEGER NOT NULL DEFAULT 0,
  show_email INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT,
  image_data TEXT,
  audio_data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((length(COALESCE(body,'')) > 0 OR length(COALESCE(image_data,'')) > 0) AND length(COALESCE(body,'')) <= 500)
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_data TEXT NOT NULL,
  audio_data TEXT,
  caption TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(story_id,viewer_id)
);
CREATE TABLE IF NOT EXISTS post_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS post_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS saved_posts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,post_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(requester_id <> target_id),
  UNIQUE(requester_id,target_id)
);
CREATE TABLE IF NOT EXISTS group_memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_slug TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,group_slug)
);
CREATE TABLE IF NOT EXISTS event_rsvps (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,event_slug)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT,
  CHECK(sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender_id,recipient_id,id);
DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now');
"@
  Invoke-Database $schema | Out-Null
  Ensure-Column "users" "profile_photo" "TEXT"
  Ensure-Column "users" "about_me" "TEXT NOT NULL DEFAULT ''"
  Ensure-Column "users" "show_email" "INTEGER NOT NULL DEFAULT 0"
  Ensure-Column "posts" "image_data" "TEXT"
  Ensure-Column "posts" "audio_data" "TEXT"
  Ensure-Column "stories" "audio_data" "TEXT"
  Ensure-Column "messages" "read_at" "TEXT"
}

function Get-PasswordHash([string]$Password, [byte[]]$Salt) {
  $derive = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
    $Password,
    $Salt,
    $script:PasswordIterations,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  try {
    return [Convert]::ToBase64String($derive.GetBytes(32))
  } finally {
    $derive.Dispose()
  }
}

function Test-Password([string]$Password, [string]$SaltText, [string]$HashText) {
  $actual = [Convert]::FromBase64String((Get-PasswordHash $Password ([Convert]::FromBase64String($SaltText))))
  $expected = [Convert]::FromBase64String($HashText)
  if ($actual.Length -ne $expected.Length) { return $false }
  $difference = 0
  for ($index = 0; $index -lt $actual.Length; $index++) {
    $difference = $difference -bor ($actual[$index] -bxor $expected[$index])
  }
  return $difference -eq 0
}

function Get-Sha256([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))
  } finally {
    $sha.Dispose()
  }
}

function New-RandomToken {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  } finally {
    $generator.Dispose()
  }
}

function New-PasswordCredentials([string]$Password) {
  $salt = New-Object byte[] 16
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($salt)
  } finally {
    $generator.Dispose()
  }
  return @{
    Salt = [Convert]::ToBase64String($salt)
    Hash = Get-PasswordHash $Password $salt
  }
}

function Get-RequestBody($Request) {
  if ($Request.ContentLength64 -gt 23068672) { throw "Request body is too large." }
  if ($Request.ContentLength64 -eq 0) { return @{} }
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
  try {
    $raw = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
  return ConvertFrom-Json -InputObject $raw
}

function ConvertTo-BrowserMedia([string]$MediaData) {
  if ($MediaData -notmatch '^data:video/[^;]+;base64,(?<payload>.+)$') {
    return [pscustomobject]@{ VideoData = $MediaData; AudioData = "" }
  }
  if (-not $script:FfmpegCommand -or -not $script:FfprobeCommand) {
    throw "FFmpeg and ffprobe are required to prepare video uploads. Install FFmpeg and add both tools to PATH."
  }

  $tempBase = Join-Path ([IO.Path]::GetTempPath()) ("circle-video-" + [Guid]::NewGuid().ToString("N"))
  $inputPath = "$tempBase-input.mp4"
  $videoPath = "$tempBase-video.mp4"
  $audioPath = "$tempBase-audio.mp3"
  try {
    [IO.File]::WriteAllBytes($inputPath, [Convert]::FromBase64String($Matches.payload))
    & $script:FfmpegCommand.Source -hide_banner -loglevel error -nostdin -y -i $inputPath -map 0:v:0 -an -sn -dn -map_metadata -1 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart $videoPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $videoPath -PathType Leaf)) {
      throw "The video could not be converted for playback."
    }

    $audioStream = & $script:FfprobeCommand.Source -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 $inputPath 2>$null
    $audioData = ""
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($audioStream -join ""))) {
      & $script:FfmpegCommand.Source -hide_banner -loglevel error -nostdin -y -i $inputPath -vn -map 0:a:0 -c:a libmp3lame -b:a 128k -ar 44100 $audioPath 2>$null
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $audioPath -PathType Leaf)) {
        throw "The audio track could not be converted for playback."
      }
      $audioData = "data:audio/mpeg;base64," + [Convert]::ToBase64String([IO.File]::ReadAllBytes($audioPath))
    }

    return [pscustomobject]@{
      VideoData = "data:video/mp4;base64," + [Convert]::ToBase64String([IO.File]::ReadAllBytes($videoPath))
      AudioData = $audioData
    }
  } finally {
    Remove-Item -LiteralPath $inputPath,$videoPath,$audioPath -Force -ErrorAction SilentlyContinue
  }
}

function ConvertPostVideos([string]$ImageData) {
  if ([string]::IsNullOrWhiteSpace($ImageData)) {
    return [pscustomobject]@{ ImageData = $ImageData; AudioData = "" }
  }
  $items = @()
  try {
    $parsed = ConvertFrom-Json -InputObject $ImageData -ErrorAction Stop
    if ($parsed -is [System.Array]) {
      $items = @($parsed)
    } else {
      $items = @([string]$parsed)
    }
  } catch {
    $items = @($ImageData)
  }

  $changed = $false
  $audioItems = @()
  for ($i = 0; $i -lt $items.Count; $i++) {
    if ([string]$items[$i] -match '^data:video/') {
      $converted = ConvertTo-BrowserMedia ([string]$items[$i])
      $items[$i] = $converted.VideoData
      $audioItems += [string]$converted.AudioData
      $changed = $true
    } else {
      $audioItems += ""
    }
  }
  if (-not $changed) {
    return [pscustomobject]@{ ImageData = $ImageData; AudioData = "" }
  }
  $nextImageData = if ($items.Count -eq 1) { [string]$items[0] } else { ConvertTo-Json -InputObject $items -Compress }
  return [pscustomobject]@{
    ImageData = $nextImageData
    AudioData = ConvertTo-Json -InputObject $audioItems -Compress
  }
}

function Write-Json($Context, [int]$StatusCode, $Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "application/json; charset=utf-8"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Write-SessionCookie($Response, [string]$Token, [int]$MaxAge) {
  if ($MaxAge -gt 0) {
    $cookie = "$script:SessionCookieName=$Token; Path=/; HttpOnly; SameSite=Strict; Max-Age=$MaxAge"
  } else {
    $cookie = "$script:SessionCookieName=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
  }
  $Response.Headers.Add("Set-Cookie", $cookie)
}

function New-Session($Response, [int64]$UserId) {
  $token = New-RandomToken
  $expiry = [DateTime]::UtcNow.AddDays($script:SessionLifetimeDays).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  Invoke-Database "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($(ConvertTo-SqlText (Get-Sha256 $token)),$UserId,$(ConvertTo-SqlText $expiry));" | Out-Null
  Write-SessionCookie $Response $token ($script:SessionLifetimeDays * 86400)
}

function Get-CurrentUser($Request) {
  $cookie = $Request.Cookies[$script:SessionCookieName]
  if ($null -eq $cookie -or [string]::IsNullOrWhiteSpace($cookie.Value)) { return $null }
  $tokenHash = ConvertTo-SqlText (Get-Sha256 $cookie.Value)
  $rows = @(Invoke-Database "SELECT u.id,u.email,u.display_name,u.profile_photo,u.about_me,u.audience,u.email_notifications,u.product_updates,u.show_email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$tokenHash AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1;")
  if ($rows.Count -eq 0) { return $null }
  return $rows[0]
}

function Test-PostVisibility([int64]$PostId, [int64]$UserId) {
  $rows = @(Invoke-Database "SELECT p.id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$PostId AND (u.audience='public' OR p.user_id=$UserId OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=$UserId AND fr.target_id=p.user_id) OR (fr.requester_id=p.user_id AND fr.target_id=$UserId)))) LIMIT 1;")
  return $rows.Count -gt 0
}

function Write-StaticFile($Context, [string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    Write-Json $Context 404 @{ error = "Not found" }
    return
  }
  $extension = [IO.Path]::GetExtension($FilePath).ToLowerInvariant()
  $contentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".js" = "text/javascript; charset=utf-8"
    ".svg" = "image/svg+xml"
    ".png" = "image/png"
    ".jpg" = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".ico" = "image/x-icon"
  }
  $bytes = [IO.File]::ReadAllBytes($FilePath)
  $Context.Response.StatusCode = 200
  $Context.Response.ContentType = $contentTypes[$extension]
  if (-not $Context.Response.ContentType) { $Context.Response.ContentType = "application/octet-stream" }
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Handle-Request($Context) {
  $request = $Context.Request
  $response = $Context.Response
  $path = $request.Url.AbsolutePath.TrimEnd("/")
  if ([string]::IsNullOrEmpty($path)) { $path = "/" }

  $origin = $request.Headers["Origin"]
  if ($origin) {
    $originUri = $null
    if (-not [Uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$originUri) -or $originUri.Authority -ne $request.Url.Authority) {
      Write-Json $Context 403 @{ error = "Cross-origin requests are not allowed." }
      return
    }
  }

  if ($request.ContentLength64 -gt 23068672) {
    Write-Json $Context 413 @{ error = "Request is too large. Choose a smaller media file." }
    return
  }

  if ($path -eq "/api/health" -and $request.HttpMethod -eq "GET") {
    Write-Json $Context 200 @{ status = "ok" }
    return
  }

  if ($path -eq "/api/register" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $email = ([string]$body.email).Trim().ToLowerInvariant()
    $displayName = ([string]$body.displayName).Trim()
    $password = [string]$body.password
    if ($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or $email.Length -gt 254) {
      Write-Json $Context 400 @{ error = "Enter a valid email address." }
      return
    }
    if ($displayName.Length -lt 1 -or $displayName.Length -gt 60) {
      Write-Json $Context 400 @{ error = "Display name must be between 1 and 60 characters." }
      return
    }
    if ($password.Length -lt 8 -or $password.Length -gt 256) {
      Write-Json $Context 400 @{ error = "Password must be at least 8 characters." }
      return
    }
    $credentials = New-PasswordCredentials $password
    try {
      $rows = @(Invoke-Database "INSERT INTO users(email,display_name,password_salt,password_hash,profile_photo) VALUES($(ConvertTo-SqlText $email),$(ConvertTo-SqlText $displayName),$(ConvertTo-SqlText $credentials.Salt),$(ConvertTo-SqlText $credentials.Hash),NULL) RETURNING id,email,display_name,profile_photo,audience,email_notifications,product_updates,show_email;")
    } catch {
      if ($_.Exception.Message -match "UNIQUE constraint failed") {
        Write-Json $Context 409 @{ error = "An account with this email already exists." }
        return
      }
      throw
    }
    New-Session $response ([int64]$rows[0].id)
    Write-Json $Context 201 @{ user = $rows[0] }
    return
  }

  if ($path -eq "/api/login" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $email = ([string]$body.email).Trim().ToLowerInvariant()
    $rows = @(Invoke-Database "SELECT id,email,display_name,password_salt,password_hash,profile_photo,audience,email_notifications,product_updates,show_email FROM users WHERE email=$(ConvertTo-SqlText $email) LIMIT 1;")
    if ($rows.Count -eq 0 -or -not (Test-Password ([string]$body.password) $rows[0].password_salt $rows[0].password_hash)) {
      Write-Json $Context 401 @{ error = "Email or password is incorrect." }
      return
    }
    New-Session $response ([int64]$rows[0].id)
    $user = $rows[0] | Select-Object id,email,display_name,profile_photo,audience,email_notifications,product_updates,show_email
    Write-Json $Context 200 @{ user = $user }
    return
  }

  if ($path -eq "/api/session" -and $request.HttpMethod -eq "GET") {
    $user = Get-CurrentUser $request
    if ($null -eq $user) {
      Write-Json $Context 200 @{ authenticated = $false }
    } else {
      Write-Json $Context 200 @{ authenticated = $true; user = $user }
    }
    return
  }

  if ($path -eq "/api/logout" -and $request.HttpMethod -eq "POST") {
    $cookie = $request.Cookies[$script:SessionCookieName]
    if ($cookie -and $cookie.Value) {
      Invoke-Database "DELETE FROM sessions WHERE token_hash=$(ConvertTo-SqlText (Get-Sha256 $cookie.Value));" | Out-Null
    }
    Write-SessionCookie $response "" 0
    Write-Json $Context 200 @{ authenticated = $false }
    return
  }

  $user = Get-CurrentUser $request
  if ($null -eq $user) {
    Write-Json $Context 401 @{ error = "Sign in to continue." }
    return
  }

  if ($path -eq "/api/settings" -and $request.HttpMethod -eq "GET") {
    Write-Json $Context 200 @{ user = $user }
    return
  }

  if ($path -eq "/api/settings" -and $request.HttpMethod -eq "PUT") {
    $body = Get-RequestBody $request
    $email = ([string]$body.email).Trim().ToLowerInvariant()
    $displayName = ([string]$body.displayName).Trim()
    $aboutMe = ([string]$body.aboutMe).Trim()
    $audience = [string]$body.audience
    $profilePhotoValue = [string]$body.profilePhoto
    if ([string]::IsNullOrWhiteSpace($profilePhotoValue)) {
      $profilePhotoSql = "NULL"
    } elseif ($profilePhotoValue.Length -gt 700000) {
      Write-Json $Context 400 @{ error = "Profile photos must be smaller than 700 KB." }
      return
    } else {
      $profilePhotoSql = $(ConvertTo-SqlText $profilePhotoValue)
    }
    if ($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or $email.Length -gt 254) {
      Write-Json $Context 400 @{ error = "Enter a valid email address." }
      return
    }
    if ($displayName.Length -lt 1 -or $displayName.Length -gt 60) {
      Write-Json $Context 400 @{ error = "Display name must be between 1 and 60 characters." }
      return
    }
    if ($aboutMe.Length -gt 500) {
      Write-Json $Context 400 @{ error = "About me must be 500 characters or fewer." }
      return
    }
    if ($audience -notin @("friends", "public", "private")) {
      Write-Json $Context 400 @{ error = "Choose a valid post audience." }
      return
    }
    try {
      Invoke-Database "UPDATE users SET email=$(ConvertTo-SqlText $email),display_name=$(ConvertTo-SqlText $displayName),profile_photo=$profilePhotoSql,about_me=$(ConvertTo-SqlText $aboutMe),audience=$(ConvertTo-SqlText $audience),email_notifications=$([int][bool]$body.emailNotifications),product_updates=$([int][bool]$body.productUpdates),show_email=$([int][bool]$body.showEmail) WHERE id=$($user.id);" | Out-Null
    } catch {
      if ($_.Exception.Message -match "UNIQUE constraint failed") {
        Write-Json $Context 409 @{ error = "That email is already used by another account." }
        return
      }
      throw
    }
    $updated = @(Invoke-Database "SELECT id,email,display_name,profile_photo,about_me,audience,email_notifications,product_updates,show_email FROM users WHERE id=$($user.id);")[0]
    Write-Json $Context 200 @{ user = $updated }
    return
  }

  if ($path -eq "/api/password" -and $request.HttpMethod -eq "PUT") {
    $body = Get-RequestBody $request
    $rows = @(Invoke-Database "SELECT password_salt,password_hash FROM users WHERE id=$($user.id) LIMIT 1;")
    if (-not (Test-Password ([string]$body.currentPassword) $rows[0].password_salt $rows[0].password_hash)) {
      Write-Json $Context 400 @{ error = "Current password is incorrect." }
      return
    }
    $newPassword = [string]$body.newPassword
    if ($newPassword.Length -lt 8 -or $newPassword.Length -gt 256) {
      Write-Json $Context 400 @{ error = "New password must be at least 8 characters." }
      return
    }
    $credentials = New-PasswordCredentials $newPassword
    Invoke-Database "UPDATE users SET password_salt=$(ConvertTo-SqlText $credentials.Salt),password_hash=$(ConvertTo-SqlText $credentials.Hash) WHERE id=$($user.id); DELETE FROM sessions WHERE user_id=$($user.id);" | Out-Null
    Write-SessionCookie $response "" 0
    Write-Json $Context 200 @{ authenticated = $false; message = "Password changed. Please sign in again." }
    return
  }

  if ($path -eq "/api/posts" -and $request.HttpMethod -eq "GET") {
    $rows = @(Invoke-Database "SELECT p.id,p.user_id,u.display_name,u.profile_photo,u.about_me,u.audience,p.body,p.image_data,p.audio_data,p.created_at,COALESCE((SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id),0) AS like_count,COALESCE((SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id=p.id),0) AS comment_count,COALESCE((SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id=p.id),0) AS share_count,CASE WHEN EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=$($user.id)) THEN 1 ELSE 0 END AS liked_by_me FROM posts p JOIN users u ON u.id=p.user_id WHERE u.audience='public' OR p.user_id=$($user.id) OR u.id IN (SELECT target_id FROM friend_requests WHERE requester_id=$($user.id) AND status='accepted') ORDER BY p.id DESC LIMIT 100;")
    Write-Json $Context 200 @{ posts = $rows }
    return
  }

  if ($path -eq "/api/stories" -and $request.HttpMethod -eq "GET") {
    $rows = @(Invoke-Database "SELECT s.id,s.user_id,u.display_name,u.profile_photo,s.media_data,s.audio_data,s.caption,s.created_at,strftime('%Y-%m-%dT%H:%M:%fZ',s.created_at,'+24 hours') AS expires_at,CASE WHEN s.user_id=$($user.id) THEN (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id=s.id) ELSE 0 END AS seen_count,EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$($user.id)) AS viewed_by_me FROM stories s JOIN users u ON u.id=s.user_id WHERE s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AND (s.user_id=$($user.id) OR u.audience='public' OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=$($user.id) AND fr.target_id=s.user_id) OR (fr.requester_id=s.user_id AND fr.target_id=$($user.id))))) ORDER BY s.created_at DESC LIMIT 50;")
    Write-Json $Context 200 @{ stories = $rows }
    return
  }

  if ($path -match '^/api/stories/(\d+)/views$' -and $request.HttpMethod -eq "GET") {
    $storyId = [int64]$matches[1]
    $owned = @(Invoke-Database "SELECT id FROM stories WHERE id=$storyId AND user_id=$($user.id) AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') LIMIT 1;")
    if ($owned.Count -eq 0) {
      Write-Json $Context 404 @{ error = "Story not found." }
      return
    }
    $viewers = @(Invoke-Database "SELECT u.id,u.display_name,u.profile_photo,sv.viewed_at FROM story_views sv JOIN users u ON u.id=sv.viewer_id WHERE sv.story_id=$storyId ORDER BY sv.viewed_at DESC;")
    Write-Json $Context 200 @{ viewers = $viewers }
    return
  }

  if ($path -match '^/api/stories/(\d+)/view$' -and $request.HttpMethod -eq "POST") {
    $storyId = [int64]$matches[1]
    $visible = @(Invoke-Database "SELECT s.id,s.user_id FROM stories s JOIN users u ON u.id=s.user_id WHERE s.id=$storyId AND s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AND (s.user_id=$($user.id) OR u.audience='public' OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=$($user.id) AND fr.target_id=s.user_id) OR (fr.requester_id=s.user_id AND fr.target_id=$($user.id))))) LIMIT 1;")
    if ($visible.Count -eq 0) {
      Write-Json $Context 404 @{ error = "Story not found." }
      return
    }
    if ([int64]$visible[0].user_id -ne [int64]$user.id) {
      Invoke-Database "INSERT OR IGNORE INTO story_views(story_id,viewer_id) VALUES($storyId,$($user.id));" | Out-Null
    }
    $seenCount = [int](Invoke-Database "SELECT COUNT(*) AS total FROM story_views WHERE story_id=$storyId;")[0].total
    Write-Json $Context 200 @{ storyId = $storyId; seenCount = $seenCount; viewedByMe = ([int64]$visible[0].user_id -ne [int64]$user.id) }
    return
  }

  if ($path -eq "/api/stories" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $mediaData = [string]$body.mediaData
    if ([string]::IsNullOrWhiteSpace($mediaData) -and -not [string]::IsNullOrWhiteSpace([string]$body.imageData)) {
      $mediaData = [string]$body.imageData
    }
    if ([string]::IsNullOrWhiteSpace($mediaData)) {
      Write-Json $Context 400 @{ error = "A story needs a photo or video." }
      return
    }
    if ($mediaData.Length -gt 20000000) {
      Write-Json $Context 400 @{ error = "Story media must be smaller than 20 MB." }
      return
    }
    $audioData = ""
    if ($mediaData -match '^data:video/') {
      try {
        $converted = ConvertTo-BrowserMedia $mediaData
        $mediaData = $converted.VideoData
        $audioData = $converted.AudioData
      } catch {
        $status = if ($_.Exception.Message -match '^FFmpeg and ffprobe are required') { 503 } else { 422 }
        Write-Json $Context $status @{ error = $_.Exception.Message }
        return
      }
      if (($mediaData.Length + $audioData.Length) -gt 20000000) {
        Write-Json $Context 400 @{ error = "The converted video is too large. Choose a shorter or smaller video." }
        return
      }
    }
    $caption = ([string]$body.caption).Trim()
    if ($caption.Length -gt 200) {
      Write-Json $Context 400 @{ error = "Story captions must be under 200 characters." }
      return
    }
    $story = @(Invoke-Database "INSERT INTO stories(user_id,media_data,audio_data,caption) VALUES($($user.id),$(ConvertTo-SqlText $mediaData),$(ConvertTo-SqlText $audioData),$(ConvertTo-SqlText $caption)) RETURNING id,user_id,media_data,audio_data,caption,created_at;" )[0]
    $story | Add-Member -NotePropertyName display_name -NotePropertyValue $user.display_name
    $story | Add-Member -NotePropertyName profile_photo -NotePropertyValue $user.profile_photo
    Write-Json $Context 201 @{ story = $story }
    return
  }

  if ($path -match '^/api/posts/(\d+)/like$' -and $request.HttpMethod -eq "POST") {
    $postId = [int64]$matches[1]
    if (-not (Test-PostVisibility $postId ([int64]$user.id))) {
      Write-Json $Context 404 @{ error = "Post not found." }
      return
    }
    $existing = @(Invoke-Database "SELECT id FROM post_likes WHERE post_id=$postId AND user_id=$($user.id) LIMIT 1;")
    $liked = $false
    if ($existing.Count -eq 0) {
      Invoke-Database "INSERT INTO post_likes(post_id,user_id) VALUES($postId,$($user.id));" | Out-Null
      $liked = $true
    } else {
      Invoke-Database "DELETE FROM post_likes WHERE post_id=$postId AND user_id=$($user.id);" | Out-Null
    }
    $likeCount = [int](Invoke-Database "SELECT COUNT(*) AS total FROM post_likes WHERE post_id=$postId;")[0].total
    Write-Json $Context 200 @{ postId = $postId; liked = $liked; likeCount = $likeCount }
    return
  }

  if ($path -match '^/api/posts/(\d+)/comments$' -and $request.HttpMethod -eq "GET") {
    $postId = [int64]$matches[1]
    if (-not (Test-PostVisibility $postId ([int64]$user.id))) {
      Write-Json $Context 404 @{ error = "Post not found." }
      return
    }
    $comments = @(Invoke-Database "SELECT pc.id,pc.body,pc.created_at,u.display_name,u.profile_photo FROM post_comments pc JOIN users u ON u.id=pc.user_id WHERE pc.post_id=$postId ORDER BY pc.created_at ASC,pc.id ASC LIMIT 100;")
    Write-Json $Context 200 @{ postId = $postId; comments = $comments }
    return
  }

  if ($path -match '^/api/posts/(\d+)/comments$' -and $request.HttpMethod -eq "POST") {
    $postId = [int64]$matches[1]
    if (-not (Test-PostVisibility $postId ([int64]$user.id))) {
      Write-Json $Context 404 @{ error = "Post not found." }
      return
    }
    $body = Get-RequestBody $request
    $text = ([string]$body.body).Trim()
    if ($text.Length -lt 1 -or $text.Length -gt 500) {
      Write-Json $Context 400 @{ error = "Comments must be between 1 and 500 characters." }
      return
    }
    $comment = @(Invoke-Database "INSERT INTO post_comments(post_id,user_id,body) VALUES($postId,$($user.id),$(ConvertTo-SqlText $text)) RETURNING id,post_id,user_id,body,created_at;")[0]
    $count = [int](Invoke-Database "SELECT COUNT(*) AS total FROM post_comments WHERE post_id=$postId;")[0].total
    Write-Json $Context 201 @{ postId = $postId; comment = $comment; commentCount = $count }
    return
  }

  if ($path -match '^/api/posts/(\d+)/share$' -and $request.HttpMethod -eq "POST") {
    $postId = [int64]$matches[1]
    if (-not (Test-PostVisibility $postId ([int64]$user.id))) {
      Write-Json $Context 404 @{ error = "Post not found." }
      return
    }
    $share = @(Invoke-Database "INSERT INTO post_shares(post_id,user_id) VALUES($postId,$($user.id)) RETURNING id,post_id,user_id,created_at;")[0]
    $count = [int](Invoke-Database "SELECT COUNT(*) AS total FROM post_shares WHERE post_id=$postId;")[0].total
    Write-Json $Context 201 @{ postId = $postId; share = $share; shareCount = $count }
    return
  }

  if ($path -eq "/api/posts" -and $request.HttpMethod -eq "DELETE") {
    $body = Get-RequestBody $request
    $postId = 0L
    if (-not [int64]::TryParse([string]$body.postId, [ref]$postId) -or $postId -le 0) {
      Write-Json $Context 400 @{ error = "Post not found." }
      return
    }

    $rows = @(Invoke-Database "SELECT id,user_id,body,image_data,audio_data FROM posts WHERE id=$postId LIMIT 1;")
    if ($rows.Count -eq 0) {
      Write-Json $Context 404 @{ error = "Post not found." }
      return
    }
    if ([int64]$rows[0].user_id -ne [int64]$user.id) {
      Write-Json $Context 403 @{ error = "You can only delete your own posts." }
      return
    }

    $imageIndex = $null
    if ($null -ne $body.photoIndex -or $null -ne $body.imageIndex) {
      $imageIndexValue = if ($null -ne $body.photoIndex) { $body.photoIndex } else { $body.imageIndex }
      $parsedIndex = 0
      if (-not [int]::TryParse([string]$imageIndexValue, [ref]$parsedIndex)) {
        Write-Json $Context 400 @{ error = "Selected photo not found." }
        return
      }
      $imageIndex = $parsedIndex
    }

    if ($null -ne $imageIndex) {
      $rawImageData = [string]$rows[0].image_data
      $imageUrls = @()
      try {
        $parsed = ConvertFrom-Json -InputObject $rawImageData
        if ($parsed -is [System.Collections.IEnumerable] -and -not ($parsed -is [string])) {
          $imageUrls = @($parsed | Where-Object { $_ })
        } elseif ($parsed) {
          $imageUrls = @($parsed)
        }
      } catch {
        if ($rawImageData.StartsWith("data:image/")) {
          $imageUrls = @($rawImageData)
        }
      }

      if ($imageIndex -lt 0 -or $imageIndex -ge $imageUrls.Count) {
        Write-Json $Context 400 @{ error = "Selected photo not found." }
        return
      }

      $updatedImages = @()
      for ($i = 0; $i -lt $imageUrls.Count; $i++) {
        if ($i -ne $imageIndex) {
          $updatedImages += $imageUrls[$i]
        }
      }
      $nextImageData = ""
      if ($updatedImages.Count -eq 1) {
        $nextImageData = [string]$updatedImages[0]
      } elseif ($updatedImages.Count -gt 1) {
        $nextImageData = ConvertTo-Json -InputObject $updatedImages -Compress
      }

      $audioUrls = @()
      try {
        $parsedAudio = ConvertFrom-Json -InputObject ([string]$rows[0].audio_data) -ErrorAction Stop
        if ($parsedAudio -is [System.Collections.IEnumerable] -and -not ($parsedAudio -is [string])) {
          $audioUrls = @($parsedAudio)
        } elseif ($parsedAudio) {
          $audioUrls = @([string]$parsedAudio)
        }
      } catch {}
      $updatedAudio = @()
      for ($i = 0; $i -lt $audioUrls.Count; $i++) {
        if ($i -ne $imageIndex) {
          $updatedAudio += $audioUrls[$i]
        }
      }
      $nextAudioData = if ($updatedAudio.Count -gt 0) { ConvertTo-Json -InputObject $updatedAudio -Compress } else { "" }

      if ($updatedImages.Count -eq 0 -and [string]::IsNullOrWhiteSpace([string]$rows[0].body)) {
        Invoke-Database "DELETE FROM posts WHERE id=$postId AND user_id=$($user.id);" | Out-Null
        Write-Json $Context 200 @{ deleted = $true; postId = $postId }
        return
      }

      Invoke-Database "UPDATE posts SET image_data=$(ConvertTo-SqlText $nextImageData),audio_data=$(ConvertTo-SqlText $nextAudioData) WHERE id=$postId;" | Out-Null
      $updated = @(Invoke-Database "SELECT p.id,p.user_id,u.display_name,u.profile_photo,u.audience,p.body,p.image_data,p.audio_data,p.created_at FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$postId LIMIT 1;")[0]
      Write-Json $Context 200 @{ post = $updated }
      return
    }

    Invoke-Database "DELETE FROM posts WHERE id=$postId AND user_id=$($user.id);" | Out-Null
    Write-Json $Context 200 @{ deleted = $true; postId = $postId }
    return
  }

  if ($path -eq "/api/posts" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $text = ([string]$body.body).Trim()
    $imageData = [string]$body.imageData
    if ([string]::IsNullOrWhiteSpace($text) -and [string]::IsNullOrWhiteSpace($imageData)) {
      Write-Json $Context 400 @{ error = "Posts must include text or media." }
      return
    }
    if ([string]::IsNullOrWhiteSpace($text) -and -not [string]::IsNullOrWhiteSpace($imageData)) {
      $text = "Shared media"
    }
    if (-not [string]::IsNullOrWhiteSpace($text) -and $text.Length -gt 500) {
      Write-Json $Context 400 @{ error = "Posts must be between 1 and 500 characters." }
      return
    }
    if (-not [string]::IsNullOrWhiteSpace($imageData) -and $imageData.Length -gt 20000000) {
      Write-Json $Context 400 @{ error = "Media uploads must be smaller than 20 MB each." }
      return
    }
    try {
      $normalizedMedia = ConvertPostVideos $imageData
      $imageData = $normalizedMedia.ImageData
      $audioData = $normalizedMedia.AudioData
    } catch {
      $status = if ($_.Exception.Message -match '^FFmpeg and ffprobe are required') { 503 } else { 422 }
      Write-Json $Context $status @{ error = $_.Exception.Message }
      return
    }
    if (($imageData.Length + $audioData.Length) -gt 20000000) {
      Write-Json $Context 400 @{ error = "The converted video is too large. Choose a shorter or smaller video." }
      return
    }
    $post = @(Invoke-Database "INSERT INTO posts(user_id,body,image_data,audio_data) VALUES($($user.id),$(ConvertTo-SqlText $text),$(ConvertTo-SqlText $imageData),$(ConvertTo-SqlText $audioData)) RETURNING id,body,image_data,audio_data,created_at;")[0]
    $post | Add-Member -NotePropertyName user_id -NotePropertyValue $user.id
    $post | Add-Member -NotePropertyName display_name -NotePropertyValue $user.display_name
    Write-Json $Context 201 @{ post = $post }
    return
  }

  if ($path -eq "/api/saved" -and $request.HttpMethod -eq "GET") {
    $rows = @(Invoke-Database "SELECT p.id,p.user_id,u.display_name,u.audience,p.body,p.created_at FROM saved_posts sp JOIN posts p ON p.id=sp.post_id JOIN users u ON u.id=p.user_id WHERE sp.user_id=$($user.id) ORDER BY sp.saved_at DESC;")
    Write-Json $Context 200 @{ posts = $rows }
    return
  }

  if ($path -eq "/api/saved" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $postId = 0L
    if (-not [int64]::TryParse([string]$body.postId, [ref]$postId)) {
      Write-Json $Context 400 @{ error = "Post not found." }
      return
    }
    if ([bool]$body.saved) {
      $visible = @(Invoke-Database "SELECT p.id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$postId AND (u.audience='public' OR p.user_id=$($user.id) OR u.id IN (SELECT target_id FROM friend_requests WHERE requester_id=$($user.id) AND status='accepted')) LIMIT 1;")
      if ($visible.Count -eq 0) {
        Write-Json $Context 404 @{ error = "Post not found." }
        return
      }
      Invoke-Database "INSERT OR IGNORE INTO saved_posts(user_id,post_id) VALUES($($user.id),$postId);" | Out-Null
    } else {
      Invoke-Database "DELETE FROM saved_posts WHERE user_id=$($user.id) AND post_id=$postId;" | Out-Null
    }
    Write-Json $Context 200 @{ postId = $postId; saved = [bool]$body.saved }
    return
  }

  if ($path -eq "/api/friends" -and $request.HttpMethod -eq "GET") {
    $rows = @(Invoke-Database "SELECT fr.id AS request_id,u.id,u.display_name,CASE WHEN u.show_email=1 THEN u.email ELSE NULL END AS email,u.show_email,fr.status,CASE WHEN fr.requester_id=$($user.id) THEN 1 ELSE 0 END AS sent_by_me FROM friend_requests fr JOIN users u ON u.id=CASE WHEN fr.requester_id=$($user.id) THEN fr.target_id ELSE fr.requester_id END WHERE fr.requester_id=$($user.id) OR fr.target_id=$($user.id) ORDER BY fr.id DESC;")
    Write-Json $Context 200 @{ friends = $rows }
    return
  }

  if ($path -eq "/api/users" -and $request.HttpMethod -eq "GET") {
    $query = ([string]$request.QueryString["q"]).Trim()
    if ($query.Length -lt 1 -or $query.Length -gt 60) {
      Write-Json $Context 200 @{ users = @() }
      return
    }
    $rows = @(Invoke-Database "SELECT id,display_name,CASE WHEN show_email=1 THEN email ELSE NULL END AS email,show_email FROM users WHERE id<>$($user.id) AND instr(lower(display_name),lower($(ConvertTo-SqlText $query)))>0 ORDER BY display_name LIMIT 20;")
    Write-Json $Context 200 @{ users = $rows }
    return
  }

  if ($path -eq "/api/friends/requests" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $targetId = 0L
    $targets = @()
    if ([int64]::TryParse([string]$body.userId, [ref]$targetId) -and $targetId -gt 0) {
      $targets = @(Invoke-Database "SELECT id FROM users WHERE id=$targetId AND id<>$($user.id) LIMIT 1;")
    } else {
      $email = ([string]$body.email).Trim().ToLowerInvariant()
      $targets = @(Invoke-Database "SELECT id FROM users WHERE email=$(ConvertTo-SqlText $email) AND id<>$($user.id) LIMIT 1;")
    }
    if ($targets.Count -eq 0) {
      Write-Json $Context 404 @{ error = "No other Circle account was found." }
      return
    }
    $targetId = [int64]$targets[0].id
    $existing = @(Invoke-Database "SELECT id,status FROM friend_requests WHERE (requester_id=$($user.id) AND target_id=$targetId) OR (requester_id=$targetId AND target_id=$($user.id)) LIMIT 1;")
    if ($existing.Count -gt 0) {
      Write-Json $Context 409 @{ error = "A friend request already exists." }
      return
    }
    Invoke-Database "INSERT INTO friend_requests(requester_id,target_id,status) VALUES($($user.id),$targetId,'pending');" | Out-Null
    Write-Json $Context 201 @{ sent = $true }
    return
  }

  if ($path -eq "/api/friends/requests" -and $request.HttpMethod -eq "PUT") {
    $body = Get-RequestBody $request
    $requestId = [int64]$body.id
    $rows = @(Invoke-Database "UPDATE friend_requests SET status='accepted' WHERE id=$requestId AND target_id=$($user.id) AND status='pending' RETURNING id;")
    if ($rows.Count -eq 0) {
      Write-Json $Context 404 @{ error = "Pending request not found." }
      return
    }
    Write-Json $Context 200 @{ accepted = $true }
    return
  }

  if ($path -eq "/api/community" -and $request.HttpMethod -eq "GET") {
    $groups = @(Invoke-Database "SELECT group_slug FROM group_memberships WHERE user_id=$($user.id);")
    $rsvps = @(Invoke-Database "SELECT event_slug FROM event_rsvps WHERE user_id=$($user.id);")
    Write-Json $Context 200 @{ groups = $groups; rsvps = $rsvps }
    return
  }

  if ($path -eq "/api/community/groups" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $slug = [string]$body.slug
    if ($slug -notin @("hikers", "recipes", "neighborhood")) {
      Write-Json $Context 400 @{ error = "Group not found." }
      return
    }
    if ([bool]$body.joined) {
      Invoke-Database "INSERT OR IGNORE INTO group_memberships(user_id,group_slug) VALUES($($user.id),$(ConvertTo-SqlText $slug));" | Out-Null
    } else {
      Invoke-Database "DELETE FROM group_memberships WHERE user_id=$($user.id) AND group_slug=$(ConvertTo-SqlText $slug);" | Out-Null
    }
    Write-Json $Context 200 @{ slug = $slug; joined = [bool]$body.joined }
    return
  }

  if ($path -eq "/api/community/events" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $slug = [string]$body.slug
    if ($slug -notin @("market", "hike", "dinner")) {
      Write-Json $Context 400 @{ error = "Event not found." }
      return
    }
    if ([bool]$body.going) {
      Invoke-Database "INSERT OR IGNORE INTO event_rsvps(user_id,event_slug) VALUES($($user.id),$(ConvertTo-SqlText $slug));" | Out-Null
    } else {
      Invoke-Database "DELETE FROM event_rsvps WHERE user_id=$($user.id) AND event_slug=$(ConvertTo-SqlText $slug);" | Out-Null
    }
    Write-Json $Context 200 @{ slug = $slug; going = [bool]$body.going }
    return
  }

  if ($path -eq "/api/messages" -and $request.HttpMethod -eq "GET") {
    $rows = @(Invoke-Database "SELECT m.id,m.sender_id,s.display_name AS sender_name,m.recipient_id,r.display_name AS recipient_name,m.body,m.created_at,m.read_at FROM messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.recipient_id WHERE m.sender_id=$($user.id) OR m.recipient_id=$($user.id) ORDER BY m.id ASC LIMIT 500;")
    Write-Json $Context 200 @{ messages = $rows }
    return
  }

  if ($path -eq "/api/messages/read" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $senderId = 0L
    if (-not [int64]::TryParse([string]$body.senderId, [ref]$senderId) -or $senderId -le 0 -or $senderId -eq [int64]$user.id) {
      Write-Json $Context 400 @{ error = "Conversation not found." }
      return
    }
    $isFriend = @(Invoke-Database "SELECT id FROM friend_requests WHERE status='accepted' AND ((requester_id=$($user.id) AND target_id=$senderId) OR (requester_id=$senderId AND target_id=$($user.id))) LIMIT 1;")
    if ($isFriend.Count -eq 0) {
      Write-Json $Context 404 @{ error = "Conversation not found." }
      return
    }
    $updated = @(Invoke-Database "UPDATE messages SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sender_id=$senderId AND recipient_id=$($user.id) AND read_at IS NULL; SELECT changes() AS updated;")
    Write-Json $Context 200 @{ senderId = $senderId; updated = [int]$updated[0].updated }
    return
  }

  if ($path -eq "/api/messages" -and $request.HttpMethod -eq "POST") {
    $body = Get-RequestBody $request
    $recipientId = [int64]$body.recipientId
    $text = ([string]$body.body).Trim()
    if ($text.Length -lt 1 -or $text.Length -gt 500) {
      Write-Json $Context 400 @{ error = "Messages must be between 1 and 500 characters." }
      return
    }
    $isFriend = @(Invoke-Database "SELECT id FROM friend_requests WHERE status='accepted' AND ((requester_id=$($user.id) AND target_id=$recipientId) OR (requester_id=$recipientId AND target_id=$($user.id))) LIMIT 1;")
    if ($isFriend.Count -eq 0) {
      Write-Json $Context 403 @{ error = "You can message accepted friends only." }
      return
    }
    $message = @(Invoke-Database "INSERT INTO messages(sender_id,recipient_id,body) VALUES($($user.id),$recipientId,$(ConvertTo-SqlText $text)) RETURNING id,body,created_at;")[0]
    Write-Json $Context 201 @{ message = $message }
    return
  }

  Write-Json $Context 404 @{ error = "API route not found." }
}

Initialize-Database
if ($Check) {
  $checkRows = @(Invoke-Database "SELECT 7 AS ready;")
  if ($checkRows.Count -ne 1 -or [int]$checkRows[0].ready -ne 7) {
    throw "SQLite row decoding check failed."
  }
  Write-Output "Backend checks passed. SQLite database: $script:DatabasePath"
  exit 0
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://${HostName}:$Port/")
try {
  $listener.Start()
} catch {
  throw "Could not listen on http://${HostName}:$Port/. $($_.Exception.Message)"
}
Write-Output "Circle backend running at http://${HostName}:$Port/"
Write-Output "SQLite database: $script:DatabasePath"
Write-Output "Press Ctrl+C to stop."

while ($listener.IsListening) {
  $context = $null
  try {
    $context = $listener.GetContext()
    if ($context.Request.HttpMethod -eq "OPTIONS") {
      $context.Response.StatusCode = 204
    } elseif ($context.Request.Url.AbsolutePath.StartsWith("/api/") -or $context.Request.Url.AbsolutePath.StartsWith("/auth/")) {
      Handle-Request $context
    } elseif ($context.Request.HttpMethod -eq "GET" -and $context.Request.Url.AbsolutePath -in @("/", "/index.html")) {
      Write-StaticFile $context (Join-Path $PSScriptRoot "index.html")
    } elseif ($context.Request.HttpMethod -eq "GET" -and $context.Request.Url.AbsolutePath -eq "/manage-posts.html") {
      Write-StaticFile $context (Join-Path $PSScriptRoot "manage-posts.html")
    } else {
      Write-Json $context 404 @{ error = "Not found" }
    }
  } catch {
    Write-Warning $_.Exception.Message
    if ($context -and -not $context.Response.OutputStream.CanWrite) {
      continue
    }
    if ($context) {
      try {
        Write-Json $context 500 @{ error = "The server could not complete that request." }
      } catch { }
    }
  } finally {
    if ($context) {
      try { $context.Response.Close() } catch { }
    }
  }
}