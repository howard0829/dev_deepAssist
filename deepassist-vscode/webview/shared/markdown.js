/*
 * 마크다운 → HTML 변환 래퍼.
 * marked로 파싱 후 DOMPurify로 sanitize. LLM 응답의 prompt-injection 방어.
 */

(function () {
    'use strict';

    function configure() {
        if (typeof marked !== 'undefined' && marked.use) {
            marked.use({
                gfm: true,
                breaks: true,
                async: false,
            });
        }
    }
    configure();

    /**
     * 마크다운 텍스트를 안전한 HTML로 변환.
     * @param {string} text
     * @returns {string} sanitized HTML
     */
    function render(text) {
        if (!text) return '';
        let html;
        try {
            html = (typeof marked !== 'undefined' && marked.parse)
                ? marked.parse(String(text))
                : escapeHtml(String(text));
        } catch (e) {
            html = escapeHtml(String(text));
        }
        if (typeof DOMPurify !== 'undefined') {
            return DOMPurify.sanitize(html, {
                ALLOWED_TAGS: [
                    'p', 'br', 'strong', 'em', 'del', 'ul', 'ol', 'li',
                    'blockquote', 'code', 'pre', 'a', 'h1', 'h2', 'h3',
                    'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr',
                    'th', 'td', 'hr', 'span', 'div', 'input',
                ],
                ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled'],
                ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
            });
        }
        return html;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.GtasMarkdown = { render, escapeHtml };
})();
