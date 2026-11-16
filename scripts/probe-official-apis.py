"""Explicitly opted-in, bounded official public API smoke probes. No credentials or retries."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 1_048_576


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoints():
    wb = 'https://api.worldbank.org/v2/country/CHN/indicator/NY.GDP.MKTP.CD'
    hk = 'https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily'
    us = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange'
    ecb = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A'
    for page in (1, 2):
        yield 'worldbank', page, wb + '?' + urllib.parse.urlencode({'format': 'json', 'date': '2020:2023', 'per_page': 2, 'page': page})
    for page in (1, 2):
        yield 'hkma', page, hk + '?' + urllib.parse.urlencode({'choose': 'end_of_day', 'from': '2024-01-02', 'to': '2024-01-05', 'pagesize': 2, 'offset': (page - 1) * 2, 'sortby': 'end_of_day', 'sortorder': 'asc', 'fields': 'end_of_day,usd,cny,eur'})
    for page in (1, 2):
        yield 'treasury', page, us + '?' + urllib.parse.urlencode({'fields': 'record_date,country_currency_desc,exchange_rate,effective_date', 'filter': 'record_date:eq:2024-03-31', 'sort': 'country_currency_desc,effective_date', 'page[size]': 2, 'page[number]': page})
    yield 'ecb', 1, ecb + '?' + urllib.parse.urlencode({'startPeriod': '2024-01-02', 'endPeriod': '2024-01-05', 'format': 'csvdata'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    opener = urllib.request.build_opener(NoRedirect())
    results = []
    failed = set()
    for provider, page, url in endpoints():
        if provider in failed:
            continue
        started = time.monotonic()
        result = {'provider': provider, 'page': page, 'requestedUrl': url,
                  'acquiredAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')}
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Xuan-BD public official data compatibility test', 'Accept': 'text/csv' if provider == 'ecb' else 'application/json'})
            with opener.open(request, timeout=18) as response:
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError('Response exceeded explicitly bounded 1 MiB probe budget')
                result.update(status=response.status, contentType=response.headers.get('Content-Type', ''), finalUrl=response.url)
            text = body.decode('utf-8-sig', errors='strict')
            if provider != 'ecb':
                json.loads(text)
            filename = provider + '-' + str(page) + ('.csv' if provider == 'ecb' else '.json')
            (root / filename).write_bytes(body)
            result.update(file=filename, bytes=len(body), sha256=hashlib.sha256(body).hexdigest(), state='received')
            print('OFFICIAL_BODY ' + provider + ' page=' + str(page) + ' ' + text[:1600], flush=True)
        except (OSError, ValueError, UnicodeError) as error:
            result.update(state='failed', error=type(error).__name__ + ': ' + str(error))
            failed.add(provider)
        result['durationSeconds'] = round(time.monotonic() - started, 3)
        results.append(result)
        print('OFFICIAL_PROBE ' + json.dumps(result, ensure_ascii=False), flush=True)
        time.sleep(1)
    manifest = {'kind': 'live_official_api_probe', 'fixture': False,
                'publication': 'not_requested', 'requestBudget': 7, 'results': results}
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    successful = {r['provider'] for r in results if r['state'] == 'received' and r['provider'] not in failed}
    print('OFFICIAL_SUMMARY ' + json.dumps({'successfulProviders': sorted(successful), 'failedProviders': sorted(failed)}), flush=True)
    if len(successful) < 2:
        raise SystemExit('Fewer than two official services completed their bounded probes; not a successful live validation')


if __name__ == '__main__':
    main()
