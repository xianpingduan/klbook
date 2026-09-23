export const pages = {
  '/learn': { surface: 'learn', label: '首页' },
  '/learn/collect': { surface: 'learn', label: '收集' },
  '/learn/mine': { surface: 'learn', label: '我的' },
  '/admin': { surface: 'admin', label: '管理概览' },
  '/admin/materials': { surface: 'admin', label: '错题资料' },
  '/admin/sources': { surface: 'admin', label: '来源管理' },
  '/admin/study': { surface: 'admin', label: '学科与学习阶段' },
  '/admin/devices': { surface: 'admin', label: '设备与账号' }
} as const;
export type PagePath = keyof typeof pages;
export function pagePath(path: string): PagePath {
  return Object.hasOwn(pages, path) ? path as PagePath : '/learn';
}
