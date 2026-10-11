import type { Locale } from '../i18n/translations'

export const CATEGORY_KEYS = [
  'dev',
  'office',
  'design',
  'writing',
  'data',
  'research',
  'business',
  'education',
  'life',
  'prompting',
] as const

export type CategoryKey = (typeof CATEGORY_KEYS)[number]

export const CATEGORY_NAMES: Record<Locale, Record<CategoryKey, string>> = {
  zh: {
    dev: '软件开发',
    office: '办公效率',
    design: '绘图设计',
    writing: '写作内容',
    data: '数据分析',
    research: '研究学习',
    business: '营销商业',
    education: '教育培训',
    life: '生活健康',
    prompting: '提示词工程',
  },
  en: {
    dev: 'Development',
    office: 'Office & Productivity',
    design: 'Design & Illustration',
    writing: 'Writing & Content',
    data: 'Data Analysis',
    research: 'Research & Learning',
    business: 'Marketing & Business',
    education: 'Education & Teaching',
    life: 'Life & Wellness',
    prompting: 'Prompt Engineering',
  },
}
