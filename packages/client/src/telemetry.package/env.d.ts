// vite.config.ts の define が注入するビルド時定数(エラー監視 — ADR §8.2)。
// 値の出どころとゲート(本番ビルドのみ実キー、dev は常に空文字)はすべて
// vite.config.ts 側にあり、ここは型だけ。vitest は client の vite.config を
// 通らないため、posthog.ts は typeof ガード越しにしか参照しない。
declare const __KAEDE_POSTHOG_KEY__: string;
declare const __KAEDE_POSTHOG_HOST__: string;
