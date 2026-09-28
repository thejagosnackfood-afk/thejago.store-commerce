param(
  [string]$ProjectId = "dasboardmarket",
  [string]$EnvFile = ".env",
  [string]$Only = "functions"
)

$ErrorActionPreference = 'Stop'

function Read-EnvFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return @{}
  }

  $result = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not ($trimmed -match '^[A-Za-z_][A-Za-z0-9_]*=')) {
      continue
    }

    $parts = $trimmed.Split('=', 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    $result[$key] = $value
  }

  return $result
}

function Resolve-Setting([hashtable]$envMap, [string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -and $value.Trim()) {
    return $value.Trim()
  }

  if ($envMap.ContainsKey($name) -and $envMap[$name].Trim()) {
    return $envMap[$name].Trim()
  }

  throw "Missing required setting: $name"
}

function Convert-ToEnvLine([string]$name, [string]$value) {
  return "$name=$value"
}

if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  throw 'Firebase CLI tidak ditemukan. Jalankan `firebase login` dulu atau install firebase-tools.'
}

$envMap = Read-EnvFile $EnvFile
$partnerId = Resolve-Setting $envMap 'SHOPEE_PARTNER_ID'
$partnerKey = Resolve-Setting $envMap 'SHOPEE_PARTNER_KEY'
$redirectUrl = Resolve-Setting $envMap 'SHOPEE_REDIRECT_URL'
$region = if ($envMap.ContainsKey('SHOPEE_REGION') -and $envMap['SHOPEE_REGION'].Trim()) { $envMap['SHOPEE_REGION'].Trim() } else { 'GLOBAL' }
$shopId = if ($envMap.ContainsKey('SHOPEE_SHOP_ID') -and $envMap['SHOPEE_SHOP_ID'].Trim()) { $envMap['SHOPEE_SHOP_ID'].Trim() } else { $null }
$accessToken = if ($envMap.ContainsKey('SHOPEE_ACCESS_TOKEN') -and $envMap['SHOPEE_ACCESS_TOKEN'].Trim()) { $envMap['SHOPEE_ACCESS_TOKEN'].Trim() } else { $null }
$refreshToken = if ($envMap.ContainsKey('SHOPEE_REFRESH_TOKEN') -and $envMap['SHOPEE_REFRESH_TOKEN'].Trim()) { $envMap['SHOPEE_REFRESH_TOKEN'].Trim() } else { $null }
$tokenExpireIn = if ($envMap.ContainsKey('SHOPEE_TOKEN_EXPIRE_IN') -and $envMap['SHOPEE_TOKEN_EXPIRE_IN'].Trim()) { $envMap['SHOPEE_TOKEN_EXPIRE_IN'].Trim() } else { $null }
$tokenExpiredAt = if ($envMap.ContainsKey('SHOPEE_TOKEN_EXPIRED_AT') -and $envMap['SHOPEE_TOKEN_EXPIRED_AT'].Trim()) { $envMap['SHOPEE_TOKEN_EXPIRED_AT'].Trim() } else { $null }
$merchantId = if ($envMap.ContainsKey('SHOPEE_MERCHANT_ID') -and $envMap['SHOPEE_MERCHANT_ID'].Trim()) { $envMap['SHOPEE_MERCHANT_ID'].Trim() } else { $null }
$functionsEnvFile = Join-Path (Join-Path $PSScriptRoot '..\functions') ".env.$ProjectId"

$lines = @(
  Convert-ToEnvLine 'SHOPEE_PARTNER_ID' $partnerId
  Convert-ToEnvLine 'SHOPEE_PARTNER_KEY' $partnerKey
  Convert-ToEnvLine 'SHOPEE_REDIRECT_URL' $redirectUrl
  Convert-ToEnvLine 'SHOPEE_REGION' $region
)

if ($shopId) { $lines += Convert-ToEnvLine 'SHOPEE_SHOP_ID' $shopId }
if ($accessToken) { $lines += Convert-ToEnvLine 'SHOPEE_ACCESS_TOKEN' $accessToken }
if ($refreshToken) { $lines += Convert-ToEnvLine 'SHOPEE_REFRESH_TOKEN' $refreshToken }
if ($tokenExpireIn) { $lines += Convert-ToEnvLine 'SHOPEE_TOKEN_EXPIRE_IN' $tokenExpireIn }
if ($tokenExpiredAt) { $lines += Convert-ToEnvLine 'SHOPEE_TOKEN_EXPIRED_AT' $tokenExpiredAt }
if ($merchantId) { $lines += Convert-ToEnvLine 'SHOPEE_MERCHANT_ID' $merchantId }

$lines | Set-Content -LiteralPath $functionsEnvFile -Encoding utf8

Write-Host "Prepared Firebase Functions environment file: $functionsEnvFile"

Write-Host "Deploying Firebase target: $Only"
firebase deploy --only $Only --project $ProjectId
