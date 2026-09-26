/**
 * 全站文案字典入口：core（导航/通用/街道/动作基础）+ table（牌桌域）+ pages（页面域）。
 * 插值占位符：{name}。新增文案必须双语登记，t() 缺 key 时原样回显 key。
 */
import { DICT as CORE_DICT } from "./dict-core";
import { TABLE_DICT } from "./dict-table";
import { PAGES_DICT } from "./dict-pages";

export const DICT = { ...CORE_DICT, ...TABLE_DICT, ...PAGES_DICT } as const;

export type DictKey = keyof typeof DICT;
