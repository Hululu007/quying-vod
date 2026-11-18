"""电影人生 -> MacCMS JSON VOD adapter. Python 3.10+."""
import copy
import json
import os
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, redirect, request
from werkzeug.exceptions import HTTPException

BASE = os.getenv('DYRS_BASE_URL', 'https://dyrs360.cc').rstrip('/')
FOURKCZ_BASE = os.getenv('FOURKCZ_BASE_URL', 'https://www.4kcz.com').rstrip('/')
SESSION_ID = os.getenv('DYRS_SION_ID', '6afc87d233c5e433b54ab53a')
PUBLIC_URL = os.getenv('PUBLIC_URL', '').rstrip('/')


def host_variants(host):
    host = (host or '').lower()
    if not host:
        return set()
    if re.fullmatch(r'[\d.]+', host):
        return {host}
    return {host, host[4:]} if host.startswith('www.') else {host, 'www.' + host}


DYRS_ALLOWED_HOSTS = host_variants(urlsplit(BASE).hostname)
if 'dyrs360.cc' in DYRS_ALLOWED_HOSTS:
    DYRS_ALLOWED_HOSTS |= host_variants('kingtv.vip')
FOURKCZ_ALLOWED_HOSTS = host_variants(urlsplit(FOURKCZ_BASE).hostname)
UPSTREAM_RETRIES = min(5, max(0, int(os.getenv('UPSTREAM_RETRIES', '2'))))
UPSTREAM_RETRY_BACKOFF = max(0.1, float(os.getenv('UPSTREAM_RETRY_BACKOFF_SECONDS', '1')))
RETRYABLE_STATUS = frozenset((429, 500, 502, 503, 504))
COLLECT_ENABLED = os.getenv('COLLECT_ENABLED', '1').lower() not in ('0', 'false', 'no')
COLLECT_INTERVAL = max(3600, int(os.getenv('COLLECT_INTERVAL_SECONDS', '86400')))
COLLECT_MAX_PAGES = min(20, max(1, int(os.getenv('COLLECT_MAX_PAGES', '3'))))
COLLECT_DETAIL_LIMIT = min(10, max(0, int(os.getenv('COLLECT_DETAIL_LIMIT', '2'))))
COLLECT_RETRY_SECONDS = max(60, int(os.getenv('COLLECT_RETRY_SECONDS', '600')))
COLLECT_CACHE_FILE = Path(os.getenv(
    'COLLECT_CACHE_FILE', str(Path(__file__).with_name('vod_collection.json'))))
COLLECT_S3_BACKUP = os.getenv(
    'COLLECT_S3_BACKUP', '1' if os.getenv('COZE_BUCKET_NAME') else '0').lower() not in ('0', 'false', 'no')
COLLECT_S3_PREFIX = os.getenv('COLLECT_S3_PREFIX', 'dyrs-vod/collection')
COLLECT_S3_BACKUP_INTERVAL = max(60, int(os.getenv('COLLECT_S3_BACKUP_INTERVAL_SECONDS', '300')))
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': BASE + '/'}
FOURKCZ_HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': FOURKCZ_BASE + '/'}
CATEGORIES = [('1', '电影', 'dianying'), ('2', '电视剧', 'dianshiju'),
              ('3', '综艺', 'zongyi'), ('4', '动漫', 'dongman'), ('5', '短剧', 'duanju')]
CLASSES = [{'type_id': i, 'type_pid': 0, 'type_name': n} for i, n, _ in CATEGORIES]
FOURKCZ_CATEGORIES = [
    ('4k', '4K站', '/'),
    ('4k-movie', '4K站-电影', '/movie_bt_series/dyy'),
    ('6k', '4K站-国产剧', '/gcj'),
    ('4k-us', '4K站-美剧', '/movie_bt_series/mj'),
    ('4k-kr', '4K站-韩剧', '/movie_bt_series/hj'),
    ('4k-jp', '4K站-日剧', '/movie_bt_series/rj'),
    ('4k-anime', '4K站-动漫', '/movie_bt_view_cat/fjj'),
    ('4k-preview', '4K站-预告', '/movie_bt_view_cat/pvyugao'),
]
FOURKCZ_CATEGORY_MAP = {i: (n, p) for i, n, p in FOURKCZ_CATEGORIES}
FOURKCZ_CLASSES = [{'type_id': i, 'type_pid': 0, 'type_name': n}
                   for i, n, _ in FOURKCZ_CATEGORIES]
ID_RE = re.compile(r'(movie|tv)/([a-f0-9]{24})-([0-9]+)')
PLAYER_RE = re.compile(r'/((?:movie|tv)/[a-f0-9]{24}/[0-9]+\.html)')
FOURKCZ_EPISODE_RE = re.compile(r'/v_play/[A-Za-z0-9_=-]+\.html')
app = Flask(__name__)
app.json.ensure_ascii = False
cache = OrderedDict()
cache_lock = threading.Lock()
collection_lock = threading.Lock()
collection_file_lock = threading.Lock()
collection_data = {}
collection_status = {
    'enabled': COLLECT_ENABLED,
    'running': False,
    'last_started': '',
    'last_finished': '',
    'last_success': False,
    'last_counts': {},
    'last_errors': [],
}
collector_stop = threading.Event()
_s3_storage = None
_last_s3_upload = 0.0


def _s3():
    """惰性初始化对象存储客户端；不可用时返回 None（快照仍走本地文件）。"""
    global _s3_storage
    if _s3_storage is None:
        _s3_storage = False
        if COLLECT_S3_BACKUP and os.getenv('COZE_BUCKET_NAME'):
            try:
                from coze_coding_dev_sdk.s3 import S3SyncStorage
                _s3_storage = S3SyncStorage(
                    endpoint_url=os.getenv('COZE_BUCKET_ENDPOINT_URL'),
                    access_key='',
                    secret_key='',
                    bucket_name=os.getenv('COZE_BUCKET_NAME'),
                    region='cn-beijing',
                )
            except Exception:
                _s3_storage = False
    return _s3_storage or None


class UpstreamError(Exception):
    pass


def upstream_url(path, params=None):
    url = urljoin(BASE + '/', path)
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or parts.netloc != urlsplit(BASE).netloc:
        raise ValueError('仅允许访问配置的源站')
    query = dict(parse_qs(parts.query, keep_blank_values=True))
    query.update(params or {})
    if SESSION_ID:
        query['sion_id'] = SESSION_ID
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), ''))


def _request_text(url, headers, label, encoding='utf-8', allow_redirects=True, retries=None):
    """读取上游页面；超时、429、5xx 按指数退避重试，其他状态码直接报错。"""
    attempts = UPSTREAM_RETRIES if retries is None else max(0, retries)
    delay = UPSTREAM_RETRY_BACKOFF
    last_error = ''
    for attempt in range(attempts + 1):
        try:
            with requests.get(url, headers=headers, timeout=(8, 20), allow_redirects=allow_redirects) as response:
                status = response.status_code
                if status in RETRYABLE_STATUS:
                    last_error = f'{label}返回 HTTP {status}'
                elif status != 200:
                    raise UpstreamError(f'{label}返回 HTTP {status}')
                else:
                    response.encoding = encoding or response.apparent_encoding or 'utf-8'
                    return response.url, response.text
        except requests.RequestException as exc:
            last_error = f'{label}请求失败或超时'
        if attempt < attempts:
            time.sleep(delay)
            delay *= 2
    if attempts:
        last_error += f'（已重试 {attempts} 次）'
    raise UpstreamError(last_error)


def fetch(path, params=None, ttl=120):
    url = upstream_url(path, params)
    with cache_lock:
        hit = cache.get(url)
        if hit and hit[0] > time.monotonic():
            cache.move_to_end(url)
            return hit[1]
    final_url, html = _request_text(url, HEADERS, '源站')
    if (urlsplit(final_url).hostname or '').lower() not in DYRS_ALLOWED_HOSTS:
        raise UpstreamError('源站跳转到了未配置的域名')
    if '<html' not in html.lower():
        raise UpstreamError('源站未返回网页')
    if ttl:
        with cache_lock:
            cache[url] = (time.monotonic() + ttl, html)
            cache.move_to_end(url)
            while len(cache) > 128:
                cache.popitem(last=False)
    return html


def fetch_source(source, path, params=None, ttl=120):
    if source == 'dyrs':
        return fetch(path, params, ttl)
    if source != '4kcz':
        raise ValueError('未知视频源')
    base = FOURKCZ_BASE
    headers = FOURKCZ_HEADERS
    url = urljoin(base + '/', path.lstrip('/'))
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.netloc != urlsplit(base).netloc:
        raise ValueError('4K站请求路径无效')
    if params:
        url += ('&' if '?' in url else '?') + urlencode(params)
    with cache_lock:
        hit = cache.get(url)
        if hit and hit[0] > time.monotonic():
            cache.move_to_end(url)
            return hit[1]
    final_url, html = _request_text(url, headers, '4K站', encoding=None)
    if (urlsplit(final_url).hostname or '').lower() not in FOURKCZ_ALLOWED_HOSTS:
        raise UpstreamError('4K站跳转到了未配置的域名')
    if '<html' not in html.lower():
        raise UpstreamError('4K站未返回网页')
    if ttl:
        with cache_lock:
            cache[url] = (time.monotonic() + ttl, html)
            cache.move_to_end(url)
            while len(cache) > 128:
                cache.popitem(last=False)
    return html


def category(name='', path=''):
    for i, n, slug in CATEGORIES:
        if name in (n, slug) or path == '/' + slug + '.html':
            return i, n
    return ('1', '电影') if path.startswith('/movie/') else ('2', '电视剧')


def clean(value):
    return re.sub(r'\s+', ' ', str(value)).strip().replace('$', '＄').replace('#', '＃')


def trusted_host(host, domain):
    return host == domain or host.endswith('.' + domain)


def parse_listing(html, page, path, page_size=24, source='dyrs', source_type=None):
    soup = BeautifulSoup(html, 'html.parser')
    rows, seen = [], set()
    if source == '4kcz':
        source_type = source_type or ('6k', '4K站-国产剧')
        for card in soup.select('.bt_img li'):
            link = card.select_one('h3.dytit a[href]')
            if not link:
                continue
            parts = urlsplit(link['href'])
            match = re.fullmatch(r'/movie/(\d+)\.html', parts.path)
            if not match:
                continue
            vid = '4kcz-' + match[1]
            if vid in seen:
                continue
            seen.add(vid)
            image = card.select_one('img[data-original], img[src]')
            badge = card.select_one('.jidi')
            rows.append({'vod_id': vid, 'vod_name': link.get_text(' ', strip=True),
                         'vod_pic': urljoin(FOURKCZ_BASE, image.get('data-original') or image.get('src') or '') if image else '',
                         'vod_remarks': badge.get_text(' ', strip=True) if badge else '',
                         'vod_year': '', 'vod_actor': next((p.get_text(' ', strip=True).partition('：')[2].strip()
                                                               for p in card.select('p.inzhuy') if '：' in p.get_text()), ''),
                         'type_id': source_type[0], 'type_name': source_type[1]})
        pages = [1]
        listing_path = urlsplit(urljoin(FOURKCZ_BASE + '/', path)).path.rstrip('/')
        current = listing_path.split('/page/', 1)[0]
        for link in soup.select('a[href]'):
            match = re.fullmatch(re.escape(current) + r'/page/(\d+)/?', urlsplit(link['href']).path)
            if match:
                pages.append(int(match[1]))
        pagecount = max(pages)
        page_size = max(page_size, len(rows))
        total = (pagecount - 1) * page_size + len(rows) if page == pagecount else pagecount * page_size
        if not rows and not soup.select('main, .mi_cont'):
            raise UpstreamError('4K站页面结构异常，无法读取列表')
        return {'code': 1, 'msg': '数据列表', 'page': page, 'pagecount': pagecount,
                'limit': page_size, 'total': total, 'total_is_estimate': page != pagecount, 'list': rows}

    for link in soup.select('a[data-cover]'):
        match = ID_RE.search(link.get('data-cover', ''))
        if not match:
            continue
        vid = '-'.join(match.groups())
        if vid in seen:
            continue
        seen.add(vid)
        card = link.parent
        img = link.find('img')
        name = link.get('title') or (img.get('alt', '') if img else '')
        spans = [x.get_text(strip=True) for x in card.select('span')]
        kind = next((v for v in spans if v in [c[1] for c in CATEGORIES]), '')
        tid, tname = category(kind, path if kind else '/' + match[1] + '/')
        badges = link.select('div.absolute')
        remarks = next((x.get_text(' ', strip=True) for x in badges
                        if any('right-2' == c for c in x.get('class', []))), '')
        rows.append({'vod_id': vid, 'vod_name': name,
                     'vod_pic': urljoin(BASE, img.get('data-src') or img.get('src') or '') if img else '',
                     'vod_remarks': remarks, 'vod_year': next((v for v in spans if re.fullmatch(r'\d{4}', v)), ''),
                     'type_id': tid, 'type_name': tname})
    pages = [1]
    for link in soup.select('a[href]'):
        parts = urlsplit(link['href'])
        q = parse_qs(parts.query)
        if parts.path == path and q.get('page', [''])[0].isdigit():
            pages.append(int(q['page'][0]) + 1)
    max_input = soup.select_one('#page-jump[max]')
    if max_input and str(max_input['max']).isdigit():
        pages.append(int(max_input['max']))
    pagecount = max(pages) if rows else max(pages) if max(pages) > 1 else 0
    page_size = max(page_size, len(rows))
    total = (pagecount - 1) * page_size + len(rows) if page == pagecount else pagecount * page_size
    if not rows and not soup.select('main'):
        raise UpstreamError('源站页面结构异常，无法读取列表')
    return {'code': 1, 'msg': '数据列表', 'page': page, 'pagecount': pagecount,
            'limit': page_size, 'total': max(0, total), 'total_is_estimate': page != pagecount,
            'list': rows}


def s3_upload_snapshot(snapshot):
    """把快照备份到对象存储（尽力而为，失败不打断本地流程）。"""
    global _last_s3_upload
    now = time.monotonic()
    if now - _last_s3_upload < COLLECT_S3_BACKUP_INTERVAL:
        return
    storage = _s3()
    if storage is None:
        return
    try:
        old_keys = storage.list_files(prefix=COLLECT_S3_PREFIX + '_', max_keys=10).get('keys') or []
        key = storage.upload_file(
            file_content=json.dumps(snapshot, ensure_ascii=False).encode('utf-8'),
            file_name=COLLECT_S3_PREFIX + '.json',
            content_type='application/json',
        )
        for old_key in old_keys:
            if old_key != key:
                storage.delete_file(file_key=old_key)
        _last_s3_upload = now
    except Exception as exc:
        _last_s3_upload = now
        write_log(f'对象存储快照备份失败：{exc}')


def write_log(message):
    try:
        with collection_file_lock:
            status = collection_status
            errors = status.setdefault('last_errors', [])
            errors.append(f'{datetime.now(timezone.utc).strftime("%H:%M:%S")} {message}')
            del errors[30:]
    except Exception:
        pass


def load_collection():
    global collection_data
    if not COLLECT_CACHE_FILE.exists():
        s3_restore_snapshot()
    if not COLLECT_CACHE_FILE.exists():
        collection_data = {'schema': 1, 'updated_at': '', 'last_run_at': '', 'pages': {}, 'details': {}}
        return
    try:
        loaded = json.loads(COLLECT_CACHE_FILE.read_text(encoding='utf-8'))
        if loaded.get('schema') == 1:
            loaded.setdefault('pages', {})
            loaded.setdefault('details', {})
            loaded.setdefault('last_run_at', '')
            collection_data = loaded
            collection_status['last_finished'] = loaded.get('last_run_at') or loaded.get('updated_at', '')
    except (OSError, ValueError, TypeError):
        collection_data = {'schema': 1, 'updated_at': '', 'last_run_at': '', 'pages': {}, 'details': {}}


def s3_restore_snapshot():
    """本地快照缺失时从对象存储恢复（尽力而为）。"""
    storage = _s3()
    if storage is None:
        return
    try:
        existing = storage.list_files(prefix=COLLECT_S3_PREFIX + '_', max_keys=5)
        keys = existing.get('keys') or []
        if not keys:
            return
        keys.sort()
        data = storage.read_file(file_key=keys[-1])
        COLLECT_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        raw = COLLECT_CACHE_FILE.with_suffix(COLLECT_CACHE_FILE.suffix + '.tmp')
        raw.write_bytes(data)
        raw.replace(COLLECT_CACHE_FILE)
    except Exception as exc:
        write_log(f'对象存储快照恢复失败：{exc}')


def save_collection():
    with collection_lock:
        collection_data['updated_at'] = datetime.now(timezone.utc).isoformat()
        snapshot = copy.deepcopy(collection_data)
    temporary_path = COLLECT_CACHE_FILE.with_suffix(COLLECT_CACHE_FILE.suffix + '.tmp')
    try:
        with collection_file_lock:
            COLLECT_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
            temporary_path.replace(COLLECT_CACHE_FILE)
    except OSError:
        pass
    s3_upload_snapshot(snapshot)


def get_collected_page(type_id, page):
    with collection_lock:
        value = collection_data.get('pages', {}).get(type_id, {}).get(str(page))
        return copy.deepcopy(value) if value else None


def store_collected_page(type_id, page, value):
    with collection_lock:
        collection_data.setdefault('pages', {}).setdefault(type_id, {})[str(page)] = copy.deepcopy(value)
    save_collection()


def collect_listing(type_id, source, page, path, params=None, source_type=None):
    cached = get_collected_page(type_id, page)
    if cached:
        return cached
    html = fetch_source(source, path, params=params)
    value = parse_listing(html, page, path, 24, source, source_type)
    store_collected_page(type_id, page, value)
    return value


def collection_is_stale():
    """只有完整跑完的一轮才顺延到下一个采集周期；中断或出错按短间隔重试。"""
    with collection_lock:
        next_run = collection_data.get('next_run_at', '')
        last_run = collection_data.get('last_run_at', '')
    try:
        if next_run:
            return datetime.now(timezone.utc) >= datetime.fromisoformat(next_run)
        if not last_run:
            return True
        return (datetime.now(timezone.utc) - datetime.fromisoformat(last_run)).total_seconds() >= COLLECT_INTERVAL
    except ValueError:
        return True


def collect_once():
    with collection_lock:
        if collection_status['running']:
            return False
        collection_status.update(running=True, last_started=datetime.now(timezone.utc).isoformat(),
                                 last_success=False, last_counts={}, last_errors=[])
    collected_counts = {}
    errors = []
    detail_ids = OrderedDict()
    root = PUBLIC_URL or 'http://localhost:9978'

    def collect_detail(vid):
        try:
            value = _fetch_detail(vid, root)
            with collection_lock:
                collection_data.setdefault('details', {})[vid] = {
                    'root': root, 'value': value,
                    'collected_at': datetime.now(timezone.utc).isoformat(),
                }
            save_collection()
        except (UpstreamError, ValueError) as exc:
            errors.append(f'{vid} 详情：{exc}')
        collector_stop.wait(0.25)

    def collect_category(type_id, source, path, label, source_type=None, params_fn=None):
        page = 1
        page_count = 1
        count = 0
        category_ids = []
        while page <= min(page_count, COLLECT_MAX_PAGES):
            page_path = path
            page_params = None
            if source == '4kcz':
                if page > 1:
                    page_path = path.rstrip('/') + f'/page/{page}'
            else:
                page_params = {'page': page - 1}
                if params_fn:
                    page_params.update(params_fn())
            try:
                html = fetch_source(source, page_path, params=page_params)
                value = parse_listing(html, page, page_path, 24, source, source_type)
                store_collected_page(type_id, page, value)
                page_count = value.get('pagecount') or 1
                count += len(value.get('list', []))
                for item in value.get('list', []):
                    if len(category_ids) >= COLLECT_DETAIL_LIMIT:
                        break
                    if item['vod_id'] not in detail_ids:
                        detail_ids[item['vod_id']] = source
                        category_ids.append(item['vod_id'])
            except (UpstreamError, ValueError) as exc:
                errors.append(f'{label} 第{page}页：{exc}')
                break
            page += 1
            collector_stop.wait(0.25)
        collected_counts[label] = count
        # 该分类列表落盘后立刻补详情，重启后不必等全部列表跑完才有选集数据
        for vid in category_ids:
            if collector_stop.is_set():
                break
            collect_detail(vid)

    try:
        for type_id, name, slug in CATEGORIES:
            if collector_stop.is_set():
                break
            collect_category(type_id, 'dyrs', '/' + slug + '.html', '电影人生-' + name)
        for type_id, name, path in FOURKCZ_CATEGORIES:
            if collector_stop.is_set():
                break
            collect_category(type_id, '4kcz', path, name, (type_id, name))
        save_collection()
    finally:
        finished = datetime.now(timezone.utc)
        finished_at = finished.isoformat()
        complete = not errors and not collector_stop.is_set()
        with collection_lock:
            if complete:
                collection_data['last_run_at'] = finished_at
                collection_data['next_run_at'] = (finished + timedelta(seconds=COLLECT_INTERVAL)).isoformat()
            else:
                collection_data['next_run_at'] = (finished + timedelta(seconds=COLLECT_RETRY_SECONDS)).isoformat()
            collection_status.update(running=False, last_finished=finished_at,
                                     last_success=complete,
                                     last_counts=collected_counts, last_errors=errors[:30])
        save_collection()
    return not errors


def collector_loop():
    load_collection()
    while not collector_stop.is_set():
        if collection_is_stale():
            collect_once()
        # 轮询而非直接睡满周期，失败后才能在 COLLECT_RETRY_SECONDS 内自动重试
        collector_stop.wait(60)


def start_collector():
    if not COLLECT_ENABLED:
        return None
    load_collection()
    thread = threading.Thread(target=collector_loop, name='daily-vod-collector', daemon=True)
    thread.start()
    return thread


load_collection()


def validate_id(vid):
    match = re.fullmatch(r'(movie|tv)-([a-f0-9]{24})-([0-9]+)', vid)
    if not match:
        raise ValueError('影片 ID 格式错误，请使用列表返回的 vod_id')
    return match.groups()


def episode_links(soup):
    result = []
    for link in soup.select('#episodeContent a[data-origin][href]'):
        if not PLAYER_RE.fullmatch(urlsplit(link['href']).path):
            continue
        title = link.get('data-title') or link.get_text(' ', strip=True)
        result.append((clean(title), link['href'], link['data-origin']))
    return result


def _fetch_detail(vid, public_url):
    if vid.startswith('4kcz-'):
        match = re.fullmatch(r'4kcz-(\d{1,8})', vid)
        if not match:
            raise ValueError('4K站影片 ID 格式错误')
        path = '/movie/' + match[1] + '.html'
        html = fetch_source('4kcz', path)
        soup = BeautifulSoup(html, 'html.parser')
        heading = soup.select_one('.dytext h1') or soup.find('h1')
        if not heading:
            raise UpstreamError('4K站影片不存在或页面结构已变更')
        info = {}
        for item in soup.select('.moviedteail_list li'):
            text = item.get_text(' ', strip=True)
            label, _, value = text.partition('：')
            info[label.strip()] = value.strip()
        image = soup.select_one('.dyimg img')
        plot = next((meta.get('content', '') for meta in soup.select('meta[property="og:description"], meta[name="description"]')
                     if meta.get('content')), '')
        if not plot:
            plot = next((x.get_text(' ', strip=True) for x in soup.select('.dytext p, .dytext .des, .dytext .summary')
                         if x.get_text(strip=True)), '')
        groups = OrderedDict()
        for link in soup.select('.paly_list_btn a[href]'):
            if re.fullmatch(r'/v_play/[A-Za-z0-9_=-]+\.html', urlsplit(link['href']).path):
                groups.setdefault('4kcz', []).append((clean(link.get_text(' ', strip=True)), link['href']))
        if not groups:
            raise UpstreamError('4K站没有可用剧集')

        def episode_url(href):
            return public_url + '/4kcz/play?url=' + requests.utils.quote(urljoin(FOURKCZ_BASE, href), safe='')

        return {'vod_id': vid, 'vod_name': heading.get_text(strip=True),
                'type_id': '4k', 'type_name': '4K站',
                'vod_pic': urljoin(FOURKCZ_BASE, image.get('src', '')) if image else '',
                'vod_year': info.get('年份', ''), 'vod_area': info.get('地区', ''), 'vod_time': soup.select_one('meta[property="og:url"]')['content'] if soup.select_one('meta[property="og:url"]') else '',
                'vod_lang': info.get('语言', ''), 'vod_actor': info.get('主演', ''),
                'vod_director': info.get('导演', ''),
                'vod_remarks': next((x.get_text(' ', strip=True) for x in soup.select('.paly_list_btn a')), ''),
                'vod_content': plot, 'vod_play_from': '$$$'.join('4kcz_' + line for line in groups),
                'vod_play_url': '$$$'.join('#'.join(title + '$' + episode_url(href) for title, href in items)
                                             for items in groups.values())}

    kind, key, suffix = validate_id(vid)
    path = f'/{kind}/{key}-{suffix}.html'
    html = fetch(path)
    soup = BeautifulSoup(html, 'html.parser')
    heading = soup.find('h1')
    if not heading:
        raise UpstreamError('影片不存在或源站页面结构已变更')
    metadata = {}
    script = soup.find('script', type='application/ld+json')
    if script:
        try:
            metadata = json.loads(script.get_text())
        except (ValueError, TypeError):
            pass
    cat = re.search(r'\bcategory\s*:\s*"([a-z]+)"', html)
    tid, tname = category(cat[1] if cat else '', path)
    groups = OrderedDict()
    initial = episode_links(soup)
    for title, href, origin in initial:
        groups.setdefault(origin, []).append((title, href))
    alternatives = []
    for button in soup.select('button[data-origin]'):
        origin = button['data-origin']
        if origin not in groups and origin not in alternatives:
            alternatives.append(origin)
    def load_line(origin):
        sp = BeautifulSoup(fetch(path, {'origin': origin}), 'html.parser')
        return origin, [(t, h) for t, h, o in episode_links(sp) if o == origin]
    failures = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [(o, pool.submit(load_line, o)) for o in alternatives[:16]]
        for origin, future in futures:
            try:
                _, items = future.result()
                if items:
                    groups[origin] = items
            except UpstreamError:
                failures.append(origin)
    if not groups:
        raise UpstreamError('源站未提供可读取的剧集')
    def play_url(href):
        parts = urlsplit(href)
        query = parse_qs(parts.query)
        params = {'path': parts.path, 'origin': query.get('origin', [''])[0],
                  'p': query.get('p', ['0'])[0]}
        return public_url + '/play.m3u8?' + urlencode(params)
    description = metadata.get('description', '')
    synopsis_heading = soup.find(['h2', 'h3'], string=re.compile('剧情简介'))
    if not synopsis_heading:
        synopsis_heading = next((x for x in soup.select('h2,h3') if '剧情简介' in x.get_text()), None)
    if synopsis_heading:
        div = synopsis_heading.find_next_sibling('div')
        if div:
            description = div.get_text(' ', strip=True)
    def names(data):
        if isinstance(data, dict):
            data = [data]
        return ','.join(x.get('name', '') for x in (data or []) if isinstance(x, dict))
    return {'vod_id': vid, 'vod_name': heading.get_text(strip=True),
            'type_id': tid, 'type_name': tname, 'vod_pic': urljoin(BASE, metadata.get('image', '')),
            'vod_year': str(metadata.get('year', '')), 'vod_area': metadata.get('countryOfOrigin', ''),
            'vod_lang': metadata.get('inLanguage', ''), 'vod_actor': names(metadata.get('actor')),
            'vod_director': names(metadata.get('director')), 'vod_remarks': initial[-1][0] if initial else '',
            'vod_content': BeautifulSoup(description, 'html.parser').get_text(' ', strip=True),
            'vod_play_from': '$$$'.join('dyrs_' + clean(o) for o in groups),
            'vod_play_url': '$$$'.join('#'.join(t + '$' + play_url(h) for t, h in items) for items in groups.values()),
            'unavailable_lines': failures}


def _rebased_detail(cached, public_url):
    value = cached.get('value', {})
    old_root = cached.get('root', '')
    if old_root and old_root != public_url:
        value['vod_play_url'] = value.get('vod_play_url', '').replace(old_root, public_url)
    return value


def detail(vid, public_url):
    with collection_lock:
        cached = copy.deepcopy(collection_data.get('details', {}).get(vid))
    if cached:
        try:
            collected_at = datetime.fromisoformat(cached.get('collected_at', ''))
            age = (datetime.now(timezone.utc) - collected_at).total_seconds()
        except ValueError:
            age = float('inf')
        if age < max(COLLECT_INTERVAL, 86400):
            return _rebased_detail(cached, public_url)
    try:
        value = _fetch_detail(vid, public_url)
    except UpstreamError:
        if cached:
            # 上游超时/限流时回退到旧快照，避免详情接口直接 502、客户端选集为空
            return _rebased_detail(cached, public_url)
        raise
    with collection_lock:
        collection_data.setdefault('details', {})[vid] = {
            'root': public_url, 'value': copy.deepcopy(value),
            'collected_at': datetime.now(timezone.utc).isoformat(),
        }
    save_collection()
    return value



def resolve_media(path, origin, episode):
    if not PLAYER_RE.fullmatch(path):
        raise ValueError('播放路径格式错误')
    if not origin or len(origin) > 100:
        raise ValueError('播放线路格式错误')
    if not re.fullmatch(r'\d{1,5}', episode):
        raise ValueError('集数格式错误')
    html = fetch(path, {'origin': origin, 'p': episode}, ttl=0)
    # Read only a JSON string literal. Never execute JavaScript from the site.
    match = re.search(r'\baa\s*:\s*JSON\.parse\(\s*\'([^\']*)\'\s*\)', html)
    if not match:
        raise UpstreamError('该线路未返回播放数据，可能不可用或需要在源站登录')
    try:
        data = json.loads(json.loads('"' + match[1] + '"'))
        media = data['url']
    except (ValueError, TypeError, KeyError) as exc:
        raise UpstreamError('源站播放数据格式异常') from exc
    media = urljoin(BASE, media)
    parts = urlsplit(media)
    if parts.scheme not in ('http', 'https') or not (re.search(r'\.(m3u8|mp4|m4v|mpd)$', parts.path, re.I)
                                                     or (parts.netloc == urlsplit(BASE).netloc and parts.path == '/api/m3u8')):
        raise UpstreamError('该线路未提供支持的媒体地址')
    if parts.netloc == urlsplit(BASE).netloc:
        media = upstream_url(media)
    return media


@app.after_request
def cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.errorhandler(ValueError)
def invalid(exc):
    return jsonify(code=0, msg=str(exc), list=[]), 400


@app.errorhandler(UpstreamError)
def upstream_failure(exc):
    return jsonify(code=0, msg=str(exc), list=[]), 502


@app.errorhandler(HTTPException)
def http_failure(exc):
    return jsonify(code=0, msg=exc.description, list=[]), exc.code


@app.get('/health')
def health():
    return jsonify(status='ok', source=BASE)


@app.get('/collector/status')
def collector_status():
    with collection_lock:
        status = copy.deepcopy(collection_status)
        status['updated_at'] = collection_data.get('updated_at', '')
        status['cached_categories'] = len(collection_data.get('pages', {}))
        status['cached_pages'] = sum(len(pages) for pages in collection_data.get('pages', {}).values())
        status['cached_details'] = len(collection_data.get('details', {}))
    status['interval_seconds'] = COLLECT_INTERVAL
    status['max_pages_per_category'] = COLLECT_MAX_PAGES
    status['details_per_category'] = COLLECT_DETAIL_LIMIT
    return jsonify(status)


@app.get('/tvbox.json')
def tvbox():
    root = PUBLIC_URL or request.url_root.rstrip('/')
    return jsonify(sites=[{'key': 'dyrs', 'name': '电影人生', 'type': 1,
                           'api': root + '/api.php/provide/vod/', 'searchable': 1,
                           'quickSearch': 1, 'filterable': 0}])


@app.get('/')
@app.get('/vod')
@app.get('/api.php/provide/vod', strict_slashes=False)
def vod():
    ac = request.args.get('ac', 'list')
    if ac not in ('list', 'detail', 'videolist'):
        raise ValueError('ac 仅支持 list、detail、videolist')
    root = PUBLIC_URL or request.url_root.rstrip('/')
    if request.args.get('ids'):
        ids = list(dict.fromkeys(request.args['ids'].split(',')))
        if len(ids) > 5:
            raise ValueError('一次最多查询 5 部影片')
        for vid in ids:
            if vid.startswith('4kcz-'):
                if not re.fullmatch(r'4kcz-\d{1,8}', vid):
                    raise ValueError('4K站影片 ID 格式错误')
            else:
                validate_id(vid)
        rows = [detail(vid, root) for vid in ids]
        return jsonify(code=1, msg='数据列表', page=1, pagecount=1, limit=len(rows), total=len(rows), list=rows)
    raw_page = request.args.get('pg', '1')
    if not re.fullmatch(r'[1-9]\d{0,5}', raw_page):
        raise ValueError('pg 必须为 1 至 999999 的整数')
    page = int(raw_page)
    tid = request.args.get('t', '')
    keyword = request.args.get('wd', '').strip()
    if len(keyword) > 100:
        raise ValueError('搜索词最多 100 个字符')
    params = {'page': page - 1}
    fourk_category = FOURKCZ_CATEGORY_MAP.get(tid)
    if tid == '4kcz':
        fourk_category = FOURKCZ_CATEGORY_MAP['4k']
    if fourk_category:
        if keyword:
            raise ValueError('暂不支持对4K站单独搜索，请选择主源搜索')
        category_name, category_path = fourk_category
        cache_type_id = '4k' if tid == '4kcz' else tid
        path = category_path.rstrip('/') or '/'
        if page > 1:
            path = path.rstrip('/') + f'/page/{page}'
        result = collect_listing(cache_type_id, '4kcz', page, path,
                                 source_type=(cache_type_id, category_name))
    elif keyword:
        path = '/s.html'
        params['name'] = keyword
        result = parse_listing(fetch(path, params), page, path, 24)
    else:
        entry = next((c for c in CATEGORIES if tid in (c[0], c[2])), None)
        if tid and not entry:
            raise ValueError('未知分类')
        path = '/' + (entry[2] if entry else 'dianying') + '.html'
        try:
            result = collect_listing(entry[0] if entry else '1', 'dyrs', page, path, params)
        except UpstreamError:
            if tid or keyword:
                raise
            fallback_path = '/'
            result = collect_listing('4k', '4kcz', 1, fallback_path, source_type=('4k', '4K站'))
            result['msg'] = '主源暂不可用，返回4K站备用源'
    if not keyword and not tid:
        result['class'] = CLASSES + FOURKCZ_CLASSES
    return jsonify(result)


@app.get('/4kcz/play')
def play_4kcz():
    target = request.args.get('url', '')
    parts = urlsplit(target)
    if parts.scheme != 'https' or parts.netloc != urlsplit(FOURKCZ_BASE).netloc or not FOURKCZ_EPISODE_RE.fullmatch(parts.path):
        raise ValueError('4K站播放地址格式错误')
    html = fetch_source('4kcz', parts.path, ttl=0)
    soup = BeautifulSoup(html, 'html.parser')
    iframe = soup.select_one('iframe.viframe[src]')
    if not iframe:
        raise UpstreamError('4K站未返回可用播放器')
    player_url = urljoin(FOURKCZ_BASE, iframe['src'])
    player_parts = urlsplit(player_url)
    if player_parts.scheme != 'https' or not player_parts.hostname or not any(
            trusted_host(player_parts.hostname, domain) for domain in ('py1080p.com', '4kcz.com')):
        raise UpstreamError('4K站播放器地址无效')
    _, player_html = _request_text(player_url, FOURKCZ_HEADERS, '4K站播放器',
                                   allow_redirects=False, retries=1)
    media = re.search(r"\b(?:const|let|var)\s+mysvg\s*=\s*(['\"])(https?://.+?)\1\s*;", player_html)
    if not media:
        media = re.search(r"\bart\.url\s*=\s*(['\"])(https?://.+?)\1\s*;", player_html)
    if media:
        media_url = media[2]
    elif re.search(r"\bart\.url\s*=\s*mysvg\s*;", player_html):
        raise UpstreamError('4K站播放器没有提供可识别的视频地址')
    else:
        raise UpstreamError('4K站播放器没有返回视频地址')
    media_parts = urlsplit(media_url)
    if media_parts.scheme != 'https' or not media_parts.hostname or not any(
            trusted_host(media_parts.hostname, domain) for domain in ('bytetos.com', 'bytedtos.com', 'py1080p.com')):
        raise UpstreamError('4K站媒体地址无效')
    return redirect(media_url, code=302)


@app.get('/play.m3u8')
@app.get('/resolve')
def play():
    media = resolve_media(request.args.get('path', ''), request.args.get('origin', ''), request.args.get('p', '0'))
    if request.path == '/resolve':
        return jsonify(parse=0, url=media, header=HEADERS)
    return redirect(media, code=302)


if __name__ == '__main__':
    from waitress import serve
    start_collector()
    serve(app, host=os.getenv('HOST', '0.0.0.0'), port=int(os.getenv('PORT', '9978')), threads=8)
