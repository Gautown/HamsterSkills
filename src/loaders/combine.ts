import type { Loader } from 'astro/loaders'

/**
 * 用同一个集合 store 顺序执行多个 loader（前者的结果会被后者看到）。
 * 用于把本地 Markdown（glob）与远端聚合（GitHub）合并进单个内容集合。
 */
export function combine(...loaders: Loader[]): Loader {
  return {
    name: loaders.map(loader => loader.name).join('+'),
    async load(context) {
      for (const loader of loaders) {
        await loader.load(context)
      }
    },
  }
}
