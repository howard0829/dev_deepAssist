/**
 * Unified diff → HTML 렌더러 (외부 의존 없음).
 *
 * 입력: `--- a/path\n+++ b/path\n@@ -10,3 +12,4 @@\n line\n+added\n-removed\n` 같은
 *       표준 unified diff 텍스트.
 * 출력: 클래스 기반 HTML 노드. CSS는 styles.css의 .diff-* 클래스로 테마 적응.
 *
 * 보안: 모든 텍스트는 escapeHtml로 처리 — 파일 내용에 prompt-injection HTML이 섞여도
 *       webview에 실행 불가능. CSP `script-src ${cspSource}`와 함께 2중 방어.
 */
(function (global) {
    'use strict';

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Unified diff 문자열을 HTML 문자열로 변환.
     * @param {string} diffText
     * @param {{maxLines?: number}} [opts] — 큰 diff의 잘림 한도 (기본 500줄)
     * @returns {string} HTML
     */
    function renderUnifiedDiff(diffText, opts) {
        if (!diffText || typeof diffText !== 'string') return '';
        var maxLines = (opts && opts.maxLines) || 500;
        var lines = diffText.split('\n');
        var truncated = false;
        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            truncated = true;
        }
        var html = ['<div class="diff-block">'];
        var addCount = 0, delCount = 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('--- ') === 0 || line.indexOf('+++ ') === 0) {
                // 파일 헤더는 한 번 표시, 작게
                html.push('<div class="diff-file-header">' + escapeHtml(line) + '</div>');
            } else if (line.indexOf('@@') === 0) {
                html.push('<div class="diff-hunk-header">' + escapeHtml(line) + '</div>');
            } else if (line.length > 0 && line.charAt(0) === '+') {
                addCount++;
                html.push('<div class="diff-add">' + escapeHtml(line) + '</div>');
            } else if (line.length > 0 && line.charAt(0) === '-') {
                delCount++;
                html.push('<div class="diff-del">' + escapeHtml(line) + '</div>');
            } else {
                html.push('<div class="diff-ctx">' + escapeHtml(line) + '</div>');
            }
        }
        if (truncated) {
            html.push('<div class="diff-truncated">… (큰 diff — ' + maxLines + '줄에서 잘림)</div>');
        }
        html.push('</div>');
        // 헤더 스탯 prefix
        var stat = '<div class="diff-stat">+' + addCount + ' -' + delCount + '</div>';
        return stat + html.join('');
    }

    global.GtasDiffRenderer = { renderUnifiedDiff: renderUnifiedDiff };
})(typeof window !== 'undefined' ? window : globalThis);
