// G-TAS VSCode 확장 번들 빌드.
//
// src/extension.ts를 단일 dist/extension.js로 번들합니다 — ws, marked, dompurify
// 등 모든 production 의존성을 인라인하여 .vsix가 node_modules 없이도 동작.
//
// 사용:
//   node esbuild.js               # 개발 빌드 (sourcemap 포함)
//   node esbuild.js --production  # 프로덕션 빌드 (minify)
//   node esbuild.js --watch       # 변경 감시
//
// vscode 모듈은 host가 주입하므로 external로 제외.

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],          // VSCode 호스트가 제공
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'info',
};

async function main() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[esbuild] 감시 모드 시작');
    } else {
        await esbuild.build(buildOptions);
        console.log(`[esbuild] 빌드 완료${production ? ' (production)' : ''}`);
    }
}

main().catch((e) => {
    console.error('[esbuild] 빌드 실패:', e);
    process.exit(1);
});
