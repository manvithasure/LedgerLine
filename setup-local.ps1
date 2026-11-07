$ErrorActionPreference = "Stop"

$mysql = @(
  "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe",
  "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $mysql) {
  throw "MySQL command-line client was not found. Install MySQL Server 8 or update setup-local.ps1 with its mysql.exe path."
}

$password = Read-Host "Enter your local MySQL root password" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
$plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

try {
  $env:MYSQL_PWD = $plainPassword
  & $mysql --user=root --protocol=TCP --execute="CREATE DATABASE IF NOT EXISTS ledgerline CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create the LedgerLine database. Check the MySQL password and try again."
  }

  $schema = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "db\schema.sql")
  $schema | & $mysql --user=root --protocol=TCP --database=ledgerline
  if ($LASTEXITCODE -ne 0) {
    throw "Could not initialize the database schema."
  }

  $envFile = Join-Path $PSScriptRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile)) {
    $envText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot ".env.example")
    $encodedPassword = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plainPassword))
    $envText = [Regex]::Replace($envText, "(?m)^MYSQL_PASSWORD_BASE64=.*$", "MYSQL_PASSWORD_BASE64=$encodedPassword")

    $randomBytes = New-Object byte[] 48
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $randomGenerator.GetBytes($randomBytes)
    $randomGenerator.Dispose()
    $jwtSecret = [Convert]::ToBase64String($randomBytes)
    $envText = [Regex]::Replace($envText, "(?m)^JWT_SECRET=.*$", "JWT_SECRET=$jwtSecret")
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($envFile, $envText, $utf8)
    Write-Host "Created .env with a generated local JWT secret."
  } else {
    Write-Host ".env already exists; it was left unchanged."
  }

  Write-Host "LedgerLine database and schema are ready."
} finally {
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  $plainPassword = $null
}
