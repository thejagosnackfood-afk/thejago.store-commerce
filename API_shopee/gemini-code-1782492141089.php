<?php
declare(strict_types=1);

const DEFAULT_SHOPEE_HOST = 'https://partner.shopeemobile.com';
const DEFAULT_AUTH_PATH = '/api/v2/shop/auth_partner';

function envValue(string $key, ?string $default = null): ?string
{
    $value = getenv($key);

    if ($value === false || trim($value) === '') {
        return $default;
    }

    return trim($value);
}

function requiredConfig(string $key): string
{
    $value = envValue($key);

    if ($value === null) {
        throw new RuntimeException("Environment variable {$key} belum diatur.");
    }

    return $value;
}

function buildShopeeAuthUrl(
    int $partnerId,
    string $partnerKey,
    string $redirectUrl,
    string $host = DEFAULT_SHOPEE_HOST,
    string $path = DEFAULT_AUTH_PATH,
    ?int $timestamp = null
): array {
    if (!filter_var($redirectUrl, FILTER_VALIDATE_URL)) {
        throw new InvalidArgumentException('SHOPEE_REDIRECT_URL harus berupa URL valid.');
    }

    $timestamp ??= time();
    $baseString = $partnerId . $path . $timestamp;
    $sign = hash_hmac('sha256', $baseString, $partnerKey);
    $query = http_build_query([
        'partner_id' => $partnerId,
        'timestamp' => $timestamp,
        'sign' => $sign,
        'redirect' => $redirectUrl,
    ], '', '&', PHP_QUERY_RFC3986);

    return [
        'base_string' => $baseString,
        'timestamp' => $timestamp,
        'url' => rtrim($host, '/') . $path . '?' . $query,
    ];
}

function loadShopeeConfig(): array
{
    $partnerId = requiredConfig('SHOPEE_PARTNER_ID');

    if (!ctype_digit($partnerId) || (int) $partnerId <= 0) {
        throw new RuntimeException('SHOPEE_PARTNER_ID harus berupa angka positif.');
    }

    return [
        'partner_id' => (int) $partnerId,
        'partner_key' => requiredConfig('SHOPEE_PARTNER_KEY'),
        'redirect_url' => requiredConfig('SHOPEE_REDIRECT_URL'),
        'host' => envValue('SHOPEE_HOST', DEFAULT_SHOPEE_HOST),
        'path' => envValue('SHOPEE_AUTH_PATH', DEFAULT_AUTH_PATH),
    ];
}

function renderCli(array $auth): void
{
    echo "Shopee authorization URL\n";
    echo "Timestamp: {$auth['timestamp']}\n";
    echo "Base string: {$auth['base_string']}\n";
    echo "URL: {$auth['url']}\n";
}

function renderHtml(array $auth, array $config): void
{
    $escapedUrl = htmlspecialchars($auth['url'], ENT_QUOTES, 'UTF-8');
    $escapedRedirect = htmlspecialchars($config['redirect_url'], ENT_QUOTES, 'UTF-8');
    $escapedHost = htmlspecialchars($config['host'], ENT_QUOTES, 'UTF-8');

    header('Content-Type: text/html; charset=UTF-8');
    echo <<<HTML
<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Shopee API Console</title>
    <style>
        :root {
            color-scheme: light;
            font-family: Arial, Helvetica, sans-serif;
            color: #1d2733;
            background: #f5f7fa;
        }
        body {
            margin: 0;
            padding: 32px;
        }
        main {
            max-width: 880px;
            margin: 0 auto;
            background: #ffffff;
            border: 1px solid #d9e1ea;
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 12px 28px rgba(29, 39, 51, 0.08);
        }
        h1 {
            margin: 0 0 8px;
            font-size: 28px;
        }
        p {
            margin: 0 0 16px;
            color: #5b6673;
            line-height: 1.5;
        }
        dl {
            display: grid;
            grid-template-columns: 140px 1fr;
            gap: 10px 16px;
            margin: 20px 0;
        }
        dt {
            font-weight: 700;
            color: #344154;
        }
        dd {
            margin: 0;
            overflow-wrap: anywhere;
        }
        textarea {
            width: 100%;
            min-height: 110px;
            box-sizing: border-box;
            padding: 12px;
            border: 1px solid #c8d3df;
            border-radius: 6px;
            font: 14px/1.45 Consolas, Monaco, monospace;
            color: #1d2733;
            background: #fbfcfe;
        }
        a.button {
            display: inline-block;
            margin-top: 14px;
            padding: 11px 16px;
            border-radius: 6px;
            color: #ffffff;
            background: #ee4d2d;
            text-decoration: none;
            font-weight: 700;
        }
        .notice {
            margin-top: 18px;
            padding: 12px 14px;
            border-left: 4px solid #e0a100;
            background: #fff8df;
            color: #5d4a16;
        }
    </style>
</head>
<body>
    <main>
        <h1>Shopee API Console</h1>
        <p>Link otorisasi ini dibuat dari environment server, bukan credential hardcoded di file PHP.</p>

        <dl>
            <dt>Partner ID</dt>
            <dd>{$config['partner_id']}</dd>
            <dt>Host</dt>
            <dd>{$escapedHost}</dd>
            <dt>Redirect</dt>
            <dd>{$escapedRedirect}</dd>
            <dt>Timestamp</dt>
            <dd>{$auth['timestamp']}</dd>
        </dl>

        <label for="auth-url"><strong>Authorization URL</strong></label>
        <textarea id="auth-url" readonly>{$escapedUrl}</textarea>
        <a class="button" href="{$escapedUrl}" target="_blank" rel="noopener">Otorisasi Toko</a>

        <div class="notice">
            Pastikan environment <strong>SHOPEE_PARTNER_ID</strong>, <strong>SHOPEE_PARTNER_KEY</strong>, dan <strong>SHOPEE_REDIRECT_URL</strong> sudah terpasang di server.
        </div>
    </main>
</body>
</html>
HTML;
}

try {
    $config = loadShopeeConfig();
    $auth = buildShopeeAuthUrl(
        $config['partner_id'],
        $config['partner_key'],
        $config['redirect_url'],
        $config['host'],
        $config['path']
    );

    if (PHP_SAPI === 'cli') {
        renderCli($auth);
        exit;
    }

    renderHtml($auth, $config);
} catch (Throwable $exception) {
    http_response_code(500);

    if (PHP_SAPI === 'cli') {
        fwrite(STDERR, "Error: {$exception->getMessage()}\n");
        exit(1);
    }

    header('Content-Type: text/plain; charset=UTF-8');
    echo "Shopee API Console error: {$exception->getMessage()}";
}
