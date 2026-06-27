/*
 * note-analyzer collector
 * ----------------------------------------------------------------------------
 * note.com にログインした状態でこのスクリプトをブックマークレットとして実行する。
 * note の内部API（同一オリジン）を叩き、記事ごとの統計・タグ・本文解析結果を
 * JSON として書き出す。出力された JSON を index.html の解析ツールに貼り付ける。
 *
 * 自分/他人リンクの判定:
 *   - note 自分: パス先頭が OWN.noteUrlname
 *   - X   自分: パス先頭が OWN.xHandles のいずれか
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';
  var NA_VERSION = '0.5.19 (2026-06-27)';
  console.log('[note-analyzer] collector v' + NA_VERSION);

  // ====== 設定（自分のアカウント識別子）======
  var OWN = {
    noteUrlname: 'kyunkyun_p_d',          // note.com/<ここ>
    xHandles: ['kyunkyun_p_dsub']          // x.com/<ここ>（小文字・複数可）
  };

  // 追加収集の有無
  var COLLECT_LIKERS = true;     // C: コア読者/リピーター分析用（スキした人を取得）
  var COLLECT_TAG_STATS = true;  // F: 勝てるタグ発見用（タグの競合度を取得）

  // 詳細取得の間隔（サーバ負荷軽減のため）
  var FETCH_INTERVAL_MS = 250;
  var MAX_PAGES = 100;        // 安全弁
  var MAX_LIKE_PAGES = 30;    // 1記事あたりのスキ一覧の最大ページ

  // ====== ユーティリティ ======
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function getJSON(url) {
    return fetch(url, { credentials: 'include', headers: { 'accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
        return res.json();
      });
  }

  // 進捗オーバーレイ
  var ui = (function () {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:20px;transform:translateX(-50%);max-width:90vw;width:480px;background:#101418;color:#e8edf2;font:14px/1.5 -apple-system,sans-serif;padding:16px 18px;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.5);';
    box.innerHTML = '<div style="font-weight:700;margin-bottom:8px">note-analyzer 収集中…</div><div id="na-msg" style="white-space:pre-wrap;word-break:break-all"></div>';
    document.body.appendChild(box);
    return {
      box: box,
      msg: function (t) { box.querySelector('#na-msg').textContent = t; },
      done: function (json) {
        box.innerHTML =
          '<div style="font-weight:700;margin-bottom:8px">収集完了 ✅</div>' +
          '<div style="margin-bottom:8px">下のJSONをコピーして解析ツールに貼り付けてください。</div>' +
          '<textarea id="na-out" style="width:100%;height:160px;font:12px/1.4 monospace;border-radius:8px;padding:8px;box-sizing:border-box"></textarea>' +
          '<div style="margin-top:8px;display:flex;gap:8px">' +
          '<button id="na-copy" style="flex:1;padding:10px;border:0;border-radius:8px;background:#2f6fed;color:#fff;font-weight:700;font-size:14px">コピー</button>' +
          '<button id="na-close" style="padding:10px 14px;border:0;border-radius:8px;background:#39424d;color:#fff;font-size:14px">閉じる</button>' +
          '</div>';
        var ta = box.querySelector('#na-out');
        ta.value = json;
        box.querySelector('#na-copy').onclick = function () {
          ta.select();
          (navigator.clipboard ? navigator.clipboard.writeText(json) : Promise.reject())
            .then(function () { this.textContent = 'コピーしました'; }.bind(this))
            .catch(function () { document.execCommand('copy'); });
        };
        box.querySelector('#na-close').onclick = function () { box.remove(); };
      },
      fail: function (e) {
        box.innerHTML = '<div style="font-weight:700;color:#ff8080;margin-bottom:8px">エラー</div><div style="white-space:pre-wrap">' +
          String(e && e.message || e) + '</div><button id="na-close" style="margin-top:10px;padding:8px 14px;border:0;border-radius:8px;background:#39424d;color:#fff">閉じる</button>';
        box.querySelector('#na-close').onclick = function () { box.remove(); };
      }
    };
  })();

  // ====== 本文HTMLの解析 ======
  function firstSeg(pathname) {
    var parts = pathname.split('/').filter(Boolean);
    return parts.length ? parts[0].toLowerCase() : '';
  }

  function analyzeBody(html) {
    var div = document.createElement('div');
    div.innerHTML = html || '';

    // 文字数（空白除く）
    var text = div.textContent || '';
    var charCount = text.replace(/\s+/g, '').length;

    // 見出し数（h1-h6）
    var headingCount = div.querySelectorAll('h1,h2,h3,h4,h5,h6').length;

    // 画像数
    var imageCount = div.querySelectorAll('img').length;

    // リンク分類
    var xSelf = 0, xOther = 0, noteSelf = 0, noteOther = 0;
    var anchors = div.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].getAttribute('href');
      if (!href) continue;
      var u;
      try { u = new URL(href, location.origin); } catch (e) { continue; }
      var host = u.hostname.toLowerCase();
      var seg = firstSeg(u.pathname);
      var isX = (host === 'x.com' || host === 'twitter.com' || host.indexOf('.twitter.com') >= 0 || host.indexOf('.x.com') >= 0);
      var isNote = (host === 'note.com' || host.indexOf('.note.com') >= 0);
      if (isX) {
        if (OWN.xHandles.indexOf(seg) >= 0) xSelf++; else xOther++;
      } else if (isNote) {
        if (seg === OWN.noteUrlname.toLowerCase()) noteSelf++; else noteOther++;
      }
    }
    return {
      charCount: charCount,
      headingCount: headingCount,
      imageCount: imageCount,
      xLinksSelf: xSelf, xLinksOther: xOther,
      noteLinksSelf: noteSelf, noteLinksOther: noteOther,
      text: text.replace(/\s+\n/g, '\n') // 構造解析用の本文（全文）
    };
  }

  function extractTags(detail) {
    var d = detail || {};
    var raw = d.hashtag_notes || d.hashtags || [];
    var tags = [];
    for (var i = 0; i < raw.length; i++) {
      var h = raw[i];
      var name = (h && h.hashtag && h.hashtag.name) || (h && h.name) || (typeof h === 'string' ? h : '');
      if (name) tags.push(String(name).replace(/^#/, ''));
    }
    return tags;
  }

  // ====== 統計API（ビュー/スキ/コメント）======
  function fetchStats() {
    var byId = {};
    var page = 1;
    function next() {
      var url = '/api/v1/stats/pv?filter=all&page=' + page + '&sort=pv';
      return getJSON(url).then(function (j) {
        var data = j.data || {};
        var list = data.note_stats || data.noteStats || (Array.isArray(data) ? data : []);
        if (page === 1) console.log('[note-analyzer] stats page1: list.length='+list.length, 'data keys:', Object.keys(data), 'last_page:', data.last_page, data.lastPage, data.total_pages, data.totalPages);
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          byId[String(s.id)] = {
            views: (s.read_count != null ? s.read_count : (s.readCount != null ? s.readCount : null)),
            likes: (s.like_count != null ? s.like_count : s.likeCount),
            comments: (s.comment_count != null ? s.comment_count : s.commentCount)
          };
        }
        var isLast = data.last_page === true || data.isLastPage === true || list.length === 0;
        ui.msg('統計取得中… page ' + page + '（' + Object.keys(byId).length + '件）');
        if (!isLast && page < MAX_PAGES) { page++; return sleep(FETCH_INTERVAL_MS).then(next); }
        return byId;
      });
    }
    return next().catch(function (e) {
      ui.msg('統計API取得失敗（ビュー数なしで継続）: ' + e.message);
      return null; // ビューが取れなくても続行
    });
  }

  // ====== 記事一覧API ======
  function fetchContents() {
    var items = [];
    var page = 1;
    function next() {
      var url = '/api/v2/creators/' + OWN.noteUrlname + '/contents?kind=note&page=' + page;
      return getJSON(url).then(function (j) {
        var data = j.data || {};
        var list = data.contents || [];
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          items.push({
            id: String(c.id),
            key: c.key,
            title: c.name || '',
            url: c.noteUrl || ('https://note.com/' + OWN.noteUrlname + '/n/' + c.key),
            publishAt: c.publishAt || c.publish_at || null,
            likes: (c.likeCount != null ? c.likeCount : null),
            comments: (c.commentCount != null ? c.commentCount : null)
          });
        }
        ui.msg('記事一覧取得中… page ' + page + '（累計 ' + items.length + '件）');
        var isLast = data.isLastPage === true || list.length === 0;
        if (!isLast && page < MAX_PAGES) { page++; return sleep(FETCH_INTERVAL_MS).then(next); }
        return items;
      });
    }
    return next();
  }

  // ====== 記事詳細API（本文・タグ）======
  function fetchDetail(key) {
    return getJSON('/api/v3/notes/' + key).then(function (j) {
      return j.data || {};
    });
  }

  // ====== スキした人の一覧（C: コア読者分析）======
  // 記事idまたはkeyから、スキしたユーザーの urlname 配列を取得する。
  function fetchLikers(noteIdOrKey) {
    if (!COLLECT_LIKERS) return Promise.resolve(null);
    var users = [];
    var page = 1;
    function next() {
      var url = '/api/v3/notes/' + noteIdOrKey + '/likes?page=' + page;
      return getJSON(url).then(function (j) {
        var data = j.data || {};
        var list = data.likes || data.users || (Array.isArray(data) ? data : []);
        if (!list.length) return users;
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          var u = item.user || item; // {user:{urlname,...}} か直接ユーザー
          var name = u.urlname || u.urlName || u.id;
          if (name) users.push(String(name));
        }
        var isLast = data.isLastPage === true || list.length === 0;
        if (!isLast && page < MAX_LIKE_PAGES) { page++; return sleep(FETCH_INTERVAL_MS).then(next); }
        return users;
      }).catch(function () { return users.length ? users : null; });
    }
    return next();
  }

  // ====== タグの競合度（F: 勝てるタグ発見）======
  // タグ名から、そのタグの記事総数（競合の多さ）を取得する。
  function fetchTagStats(tags) {
    if (!COLLECT_TAG_STATS) return Promise.resolve({});
    var unique = [];
    var seen = {};
    for (var i = 0; i < tags.length; i++) {
      if (!seen[tags[i]]) { seen[tags[i]] = 1; unique.push(tags[i]); }
    }
    var result = {};
    var idx = 0;
    function next() {
      if (idx >= unique.length) return Promise.resolve(result);
      var tag = unique[idx];
      ui.msg('タグ競合度取得中… ' + (idx + 1) + '/' + unique.length + '\n#' + tag);
      return getJSON('/api/v2/hashtags/' + encodeURIComponent(tag)).then(function (j) {
        var d = (j.data && (j.data.hashtag || j.data)) || {};
        var cnt = d.note_count != null ? d.note_count
                : d.noteCount != null ? d.noteCount
                : d.count != null ? d.count : null;
        result[tag] = cnt;
      }).catch(function () { result[tag] = null; })
        .then(function () { idx++; return sleep(FETCH_INTERVAL_MS).then(next); });
    }
    return next();
  }

  // ====== メイン ======
  Promise.all([fetchStats(), fetchContents()])
    .then(function (res) {
      var stats = res[0];
      var items = res[1];
      var articles = [];
      var idx = 0;

      function step() {
        if (idx >= items.length) return Promise.resolve();
        var it = items[idx];
        ui.msg('本文解析中… ' + (idx + 1) + '/' + items.length + '\n' + it.title);
        var detailData;
        return fetchDetail(it.key).then(function (detail) {
          detailData = detail;
          return fetchLikers(it.key);
        }).then(function (likers) {
          var detail = detailData;
          var body = detail.body || detail.note_body || '';
          var an = analyzeBody(body);
          var st = stats && stats[it.id] ? stats[it.id] : null;
          // ビュー数: 統計API → 詳細APIフォールバック
          var views = st ? st.views : (detail.read_count != null ? detail.read_count : (detail.readCount != null ? detail.readCount : null));
          var likes = st && st.likes != null ? st.likes : (detail.like_count != null ? detail.like_count : (detail.likeCount != null ? detail.likeCount : it.likes));
          var comments = st && st.comments != null ? st.comments : (detail.comment_count != null ? detail.comment_count : (detail.commentCount != null ? detail.commentCount : it.comments));
          articles.push({
            id: it.id,
            key: it.key,
            url: it.url,
            title: it.title,
            titleLength: (it.title || '').length,
            publishAt: it.publishAt,
            views: views,
            likes: likes,
            comments: comments,
            tags: extractTags(detail),
            charCount: an.charCount,
            headingCount: an.headingCount,
            imageCount: an.imageCount,
            xLinksSelf: an.xLinksSelf,
            xLinksOther: an.xLinksOther,
            noteLinksSelf: an.noteLinksSelf,
            noteLinksOther: an.noteLinksOther,
            text: an.text,
            likers: likers
          });
          idx++;
          return sleep(FETCH_INTERVAL_MS).then(step);
        }).catch(function (e) {
          // 個別記事の失敗はスキップ
          articles.push({
            id: it.id, key: it.key, url: it.url, title: it.title,
            titleLength: (it.title || '').length, publishAt: it.publishAt,
            views: null, likes: it.likes, comments: it.comments, tags: [],
            charCount: null, headingCount: null, imageCount: null,
            xLinksSelf: null, xLinksOther: null, noteLinksSelf: null, noteLinksOther: null,
            likers: null, error: String(e.message || e)
          });
          idx++;
          return sleep(FETCH_INTERVAL_MS).then(step);
        });
      }

      return step().then(function () {
        // 全記事のタグを集めて競合度を取得（F）
        var allTags = [];
        for (var i = 0; i < articles.length; i++) {
          if (articles[i].tags) allTags = allTags.concat(articles[i].tags);
        }
        return fetchTagStats(allTags).then(function (tagStats) {
          var out = {
            meta: {
              urlname: OWN.noteUrlname,
              exportedAt: new Date().toISOString(),
              count: articles.length,
              hasViews: !!stats,
              hasLikers: COLLECT_LIKERS,
              tagStats: tagStats,
              schema: 1
            },
            articles: articles
          };
          ui.done(JSON.stringify(out, null, 2));
        });
      });
    })
    .catch(function (e) { ui.fail(e); });
})();
