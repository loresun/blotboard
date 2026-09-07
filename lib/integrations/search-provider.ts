/**
 * 资料检索 Provider：资料卡「从知识库捞一批」背后的那一个接口。
 *
 * 现在只有一个实现（见 lib/aidocs.ts）；未配置（env `AIDOCS_URL` 为空）
 * 时换成 null 实现，统一抛 503 的结构化错误。入口此时不渲染（lib/features.ts）。
 */
import { searchAidocs, type AidocsSearchInput, type AidocsSearchResult } from "../aidocs";
import { FEATURES } from "../features";
import { ApiError } from "../http";

export type { AidocsSearchInput as SearchInput, AidocsSearchResult as SearchResult };

export interface SearchProvider {
  search(input: AidocsSearchInput): Promise<AidocsSearchResult>;
}

const aidocsProvider: SearchProvider = { search: searchAidocs };

const disabledProvider: SearchProvider = {
  search: () => {
    throw new ApiError("知识库未配置（设置 AIDOCS_URL 环境变量后启用资料卡检索）", 503);
  },
};

export const searchProvider: SearchProvider = FEATURES.search ? aidocsProvider : disabledProvider;
