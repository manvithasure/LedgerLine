$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot
$mysqlPasswordPointer = [IntPtr]::Zero
$adminPasswordPointer = [IntPtr]::Zero
$environmentNames = @(
  "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD",
  "MYSQL_PASSWORD_BASE64", "MYSQL_DATABASE", "MYSQL_SSL",
  "MYSQL_SSL_CA_BASE64", "DB_DIALECT", "BOOTSTRAP_ADMIN_EMAIL",
  "BOOTSTRAP_ADMIN_NAME", "BOOTSTRAP_ADMIN_PASSWORD"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "The project build failed. Fix the build before creating the cloud administrator."
  }

  $dbHost = Read-Host "TiDB host name"
  $dbPortInput = Read-Host "TiDB port [4000]"
  $dbPort = if ($dbPortInput) { $dbPortInput } else { "4000" }
  $database = Read-Host "Database name [ledgerline]"
  if (-not $database) {
    $database = "ledgerline"
  }
  $dbUser = Read-Host "Restricted TiDB runtime username"
  $mysqlPassword = Read-Host "Restricted TiDB runtime password" -AsSecureString
  $mysqlPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mysqlPassword)
  $plainMysqlPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mysqlPasswordPointer)

  $adminEmail = Read-Host "First administrator email"
  $adminName = Read-Host "First administrator display name"
  $adminPassword = Read-Host "First administrator password (12 to 72 bytes)" -AsSecureString
  $adminPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPassword)
  $plainAdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPasswordPointer)

  $env:MYSQL_HOST = $dbHost
  $env:MYSQL_PORT = $dbPort
  $env:MYSQL_USER = $dbUser
  $env:MYSQL_PASSWORD = $plainMysqlPassword
  $env:MYSQL_PASSWORD_BASE64 = ""
  $env:MYSQL_DATABASE = $database
  $env:MYSQL_SSL = "true"
  $env:MYSQL_SSL_CA_BASE64 = ""
  $env:DB_DIALECT = "tidb"
  $env:BOOTSTRAP_ADMIN_EMAIL = $adminEmail
  $env:BOOTSTRAP_ADMIN_NAME = $adminName
  $env:BOOTSTRAP_ADMIN_PASSWORD = $plainAdminPassword

  npm run create-admin
  if ($LASTEXITCODE -ne 0) {
    throw "The cloud administrator was not created. Check the connection, access list, and runtime-user grants."
  }
} finally {
  foreach ($name in $environmentNames) {
    if ($null -eq $originalEnvironment[$name]) {
      Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
    }
  }

  if ($mysqlPasswordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mysqlPasswordPointer)
  }
  if ($adminPasswordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPasswordPointer)
  }
  $plainMysqlPassword = $null
  $plainAdminPassword = $null
  Pop-Location
}
