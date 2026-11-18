import json
import unittest
from unittest.mock import patch

import app as service


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.client = service.app.test_client()

    def test_pagination_and_unicode(self):
        html = '''<html><main><div><a data-cover="/movie/aaaaaaaaaaaaaaaaaaaaaaaa-12.html" title="太阳">
        <img data-src="/img/a.jpg"><div class="absolute right-2">高清</div></a>
        <span>2026</span><span>电影</span></div>
        <a href="/s.html?name=x&amp;page=8">9</a></main></html>'''
        with patch.object(service, 'fetch', return_value=html) as fetch:
            r = self.client.get('/vod', query_string={'wd': '太阳', 'pg': 2})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(fetch.call_args.args[1], {'page': 1, 'name': '太阳'})
        data = r.get_json()
        self.assertEqual(data['pagecount'], 9)
        self.assertEqual(data['list'][0]['vod_name'], '太阳')
        self.assertEqual(data['list'][0]['vod_remarks'], '高清')

    def test_empty_result(self):
        with patch.object(service, 'fetch', return_value='<html><main></main></html>'):
            r = self.client.get('/vod?wd=absent')
        self.assertEqual(r.get_json()['list'], [])
        self.assertEqual(r.get_json()['total'], 0)

    def test_reject_invalid_inputs_before_fetch(self):
        with patch.object(service, 'fetch') as fetch:
            for path in ['/vod?pg=0', '/vod?t=999', '/vod?ids=invalid',
                         '/play.m3u8?path=https://example.com&origin=x',
                         '/play.m3u8?path=/movie/aaaaaaaaaaaaaaaaaaaaaaaa/1.html&origin=x&p=-1']:
                self.assertEqual(self.client.get(path).status_code, 400)
            fetch.assert_not_called()

    def test_upstream_failure_is_json(self):
        with patch.object(service, 'fetch', side_effect=service.UpstreamError('source unavailable')), patch.object(
                service, 'fetch_source', side_effect=service.UpstreamError('backup unavailable')):
            r = self.client.get('/vod')
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.get_json()['code'], 0)

    def test_extract_media_without_executing_script(self):
        data = json.dumps({'url': 'https://cdn.example.com/index.m3u8?a=1&b=2'})
        escaped = json.dumps(data, ensure_ascii=True)[1:-1]
        html = "<html><script>window.xg_video_player_doc={aa:JSON.parse('" + escaped + "')};</script></html>"
        with patch.object(service, 'fetch', return_value=html):
            r = self.client.get('/play.m3u8', query_string={
                'path': '/movie/aaaaaaaaaaaaaaaaaaaaaaaa/12.html', 'origin': 'x', 'p': 0})
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r.headers['Location'], 'https://cdn.example.com/index.m3u8?a=1&b=2')

    def test_4kcz_listing_and_pagination(self):
        html = """<html><div class="bt_img"><ul><li><a><img data-original="/cover.jpg"><div class="jidi">更新至9集</div></a><h3 class="dytit"><a href="https://www.4kcz.com/movie/24112.html">今天是太阳雨</a></h3></li></ul></div><a class="page-numbers" href="https://www.4kcz.com/gcj/page/4">4</a></html>"""
        with patch.object(service, 'fetch_source', return_value=html) as fetch:
            response = self.client.get('/vod?t=6k&pg=2')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(fetch.call_args.args[:3], ('4kcz', '/gcj/page/2'))
        row = response.get_json()['list'][0]
        self.assertEqual(row['vod_id'], '4kcz-24112')
        self.assertEqual(row['vod_name'], '今天是太阳雨')
        self.assertEqual(row['vod_remarks'], '更新至9集')
        self.assertEqual(response.get_json()['pagecount'], 4)

    def test_4kcz_detail_and_episode_playback(self):
        detail_html = """<html><div class="dytext"><h1>今天是太阳雨</h1><ul class="moviedteail_list"><li>年份：<a>2026</a></li><li>地区：<a>中国大陆</a></li><li>主演：<span>演员甲</span><span>演员乙</span></li></ul></div><div class="dyimg"><img src="/poster.jpg"></div><div class="paly_list_btn"><a href="/v_play/bXZfMjQxMTItbm1fMQ==.html">第1集</a></div></html>"""
        play_html = """<html><iframe class="viframe" src="https://plaa.py1080p.com:8181/player/py.php?url=encoded"></iframe></html>"""
        player_html = '''<html><script>const mysvg = 'https://lf3-csp-sign.bytetos.com/video.mp4?token=abc'; art.url=mysvg;</script></html>'''
        with patch.object(service, 'fetch_source', side_effect=[detail_html, play_html]), patch.object(
                service.requests, 'get') as request_get:
            request_get.return_value.__enter__.return_value.status_code = 200
            request_get.return_value.__enter__.return_value.text = player_html
            details = self.client.get('/vod?ids=4kcz-24112').get_json()['list'][0]
            self.assertEqual(details['vod_play_from'], '4kcz_4kcz')
            self.assertEqual(details['vod_year'], '2026')
            self.assertEqual(details['vod_actor'], '演员甲 演员乙')
            episode_url = details['vod_play_url'].split('$', 1)[1]
            response = self.client.get(episode_url.replace('http://localhost', ''))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers['Location'], 'https://lf3-csp-sign.bytetos.com/video.mp4?token=abc')

    def test_4kcz_play_rejects_untrusted_url(self):
        response = self.client.get('/4kcz/play?url=https://example.com/v_play/a.html')
        self.assertEqual(response.status_code, 400)

    def test_detail_groups_are_aligned(self):
        html = '''<html><h1>Example</h1><script type="application/ld+json">{"name":"Example"}</script>
        <div id="episodeContent"><a data-origin="line1" href="/tv/aaaaaaaaaaaaaaaaaaaaaaaa/12.html?origin=line1&amp;p=0">One</a></div>
        <button data-origin="line2"></button></html>'''
        alternate = html.replace('line1', 'line2')
        with patch.object(service, 'fetch', side_effect=[html, alternate]):
            r = self.client.get('/vod?ids=tv-aaaaaaaaaaaaaaaaaaaaaaaa-12')
        self.assertEqual(r.status_code, 200)
        v = r.get_json()['list'][0]
        self.assertEqual(len(v['vod_play_from'].split('$$$')), 2)
        self.assertEqual(len(v['vod_play_url'].split('$$$')), 2)
        self.assertIn('origin=line2', v['vod_play_url'])


if __name__ == '__main__':
    unittest.main()
