import requests
import base64
import hmac
import hashlib
import json
import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GINEE_CONFIG = ROOT / 'scripts' / 'sid-connector' / 'ginee.json'
DEFAULT_SHOP_ID = 'SH6AB32983CFF47E0001A753EC'


def load_ginee_config():
    config = {
        'appKey': os.getenv('GINEE_APP_KEY', '').strip(),
        'appSecret': os.getenv('GINEE_APP_SECRET', '').strip(),
        'shopId': os.getenv('GINEE_SHOP_ID', '').strip(),
    }
    if GINEE_CONFIG.exists():
        try:
            local_config = json.loads(GINEE_CONFIG.read_text(encoding='utf-8'))
        except json.JSONDecodeError as error:
            raise ValueError(f"Format {GINEE_CONFIG} tidak valid: {error}") from error
        for source, target in (('appKey', 'appKey'), ('appSecret', 'appSecret'), ('shopId', 'shopId')):
            if not config[target] and isinstance(local_config.get(source), str):
                config[target] = local_config[source].strip()
    missing = [name for name in ('appKey', 'appSecret') if not config[name] or config[name].startswith('ISI_')]
    if missing:
        raise ValueError(
            'Kredensial Ginee belum diisi. Gunakan env GINEE_APP_KEY/GINEE_APP_SECRET '
            'atau scripts/sid-connector/ginee.json.'
        )
    return config


SHOP_ID = os.getenv('GINEE_SHOP_ID', '').strip() or DEFAULT_SHOP_ID

# Base URL Resmi OpenAPI Ginee
BASE_URL = 'https://api.ginee.com'
ENDPOINT = '/openapi/v3/oms/order/item/batch-get'

def generate_authorization(app_key, app_secret, method, request_uri):
    sign_data = f'{method}${request_uri}$'
    signature = hmac.new(
        app_secret.encode('utf-8'),
        sign_data.encode('utf-8'),
        hashlib.sha256
    ).digest()
    encoded_signature = base64.b64encode(signature).decode('ascii')
    return f'{app_key}:{encoded_signature}'

def summarize_response(data):
    if not isinstance(data, dict):
        return {'type': type(data).__name__}
    payload = data.get('data')
    if isinstance(payload, list):
        count = len(payload)
    elif isinstance(payload, dict):
        rows = payload.get('content') if isinstance(payload.get('content'), list) else None
        count = len(rows) if rows is not None else None
    else:
        count = None
    return {
        'code': data.get('code'),
        'message': data.get('message'),
        'transactionId': data.get('transactionId'),
        'returnedCount': count,
    }


def get_ginee_order_items(order_ids=None, external_order_ids=None, shop_id=None, verbose=False):
    config = load_ginee_config()
    if order_ids and external_order_ids:
        raise ValueError("Gunakan salah satu: orderIds atau externalOrderIds.")
    payload = {}
    for field, values in (("orderIds", order_ids), ("externalOrderIds", external_order_ids)):
        if values is not None:
            if not isinstance(values, (list, tuple)) or any(
                not isinstance(value, str) or not value.strip() for value in values
            ):
                raise ValueError(f"{field} harus berupa daftar ID string yang tidak kosong.")
            if values:
                payload[field] = [value.strip() for value in values]
    if not payload:
        raise ValueError("Isi minimal satu orderIds atau externalOrderIds.")
    if 'externalOrderIds' in payload and shop_id is None and SHOP_ID is not None:
        shop_id = SHOP_ID
    if shop_id is not None:
        if not isinstance(shop_id, str) or not shop_id.strip():
            raise ValueError("shopId harus berupa string yang tidak kosong.")
        payload['shopId'] = shop_id.strip()
    if 'externalOrderIds' in payload and 'shopId' not in payload:
        raise ValueError("Pencarian externalOrderIds memerlukan --shop-id (ID toko Ginee).")

    headers = {
        'Content-Type': 'application/json',
        'X-Advai-Country': 'ID',
        'Authorization': generate_authorization(config['appKey'], config['appSecret'], 'POST', ENDPOINT),
    }

    try:
        url = BASE_URL + ENDPOINT
        print(f"[INFO] Mengirim request ke {url}...")
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        
        print(f"[HTTP Status] {response.status_code}")
        data = response.json()
        label = "[RESPONSE DATA]" if verbose else "[RESPONSE SUMMARY]"
        print(f"{label}:")
        print(json.dumps(data if verbose else summarize_response(data), indent=2))
        
        if response.ok and isinstance(data, dict) and data.get("code") == "SUCCESS":
            if not data.get('data'):
                print("\nAPI berhasil diakses, tetapi data pesanan kosong.")
            else:
                print("\n✅ KONEKSI API BERHASIL!")
            return True
        else:
            message = data.get('message') if isinstance(data, dict) else data
            print(f"\n⚠️ Respon Ginee: {message}")
            if isinstance(data, dict) and data.get('code') == 'IAM_FAILED':
                print("Akses endpoint ditolak Ginee. Periksa izin API aplikasi; bukan berarti pesanan tidak ada.")

    except requests.exceptions.ConnectionError as e:
        print(f"[ERROR KONEKSI/DNS] Gagal terhubung ke host: {e}")
    except requests.exceptions.JSONDecodeError:
        print("[ERROR RESPONSE] Respons Ginee bukan JSON yang valid.")
    except requests.exceptions.RequestException as e:
        print(f"[ERROR REQUEST] {e}")
    return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test Ginee OMS API v3: item pesanan.")
    parser.add_argument('--connector-url', help='URL halaman connector, misalnya https://dasboardmarket.firebaseapp.com/shopee')
    ids = parser.add_mutually_exclusive_group()
    ids.add_argument('--order-ids', nargs='+', help='ID pesanan internal Ginee')
    ids.add_argument('--external-order-ids', nargs='+', help='ID pesanan eksternal/marketplace')
    parser.add_argument('--shop-id', default=SHOP_ID, help='ID toko Ginee. Bisa juga diisi lewat GINEE_SHOP_ID atau ginee.json.')
    parser.add_argument('--verbose', action='store_true', help='Cetak respons lengkap. Gunakan hanya untuk debug lokal.')
    args = parser.parse_args()
    if args.connector_url:
        if args.order_ids or args.external_order_ids:
            parser.error('--connector-url mengambil pesanan dari Shopee; jangan sertakan ID manual.')
        try:
            response = requests.post(args.connector_url.rstrip('/') + '/api/integration/check',
                                     headers={'Accept': 'application/json'}, timeout=45)
            data = response.json()
            print(f'[HTTP Status] {response.status_code}')
            print(json.dumps(data, indent=2))
            raise SystemExit(0 if response.status_code == 200 and data.get('ok') is True else 1)
        except (requests.RequestException, ValueError) as error:
            print(f'[ERROR] {error}')
            raise SystemExit(1)
    if not args.order_ids and not args.external_order_ids:
        parser.error('Isi --connector-url, --order-ids, atau --external-order-ids.')
    try:
        success = get_ginee_order_items(args.order_ids, args.external_order_ids, args.shop_id, args.verbose)
    except ValueError as e:
        parser.error(str(e))
    raise SystemExit(0 if success else 1)
