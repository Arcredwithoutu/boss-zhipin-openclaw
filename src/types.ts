// src/types.ts
export type SalaryFilter = {
  min?: number; // 千元，e.g., 15 = 15k
  max?: number;
};

export type Filters = {
  cities?: string[];          // 城市名，e.g., ["北京", "上海"]
  cityCodes?: string[];       // 城市代码，e.g., ["101010100"]
  salary?: SalaryFilter;
  keywords?: string[];        // 岗位关键词
  publishedWithin?: string;   // e.g., "3h", "24h", "7d"
};

export type PluginState = {
  cookie?: string;
  cookieUpdatedAt?: string;   // ISO string
  cookieExpired?: boolean;
  filters?: Filters;
};

export type JobItem = {
  encryptJobId: string;
  jobName: string;
  brandName: string;
  brandScaleName?: string;    // 公司规模，如 "10000人以上"
  brandIndustry?: string;     // 行业，如 "互联网"
  cityName: string;
  areaDistrict?: string;
  salaryDesc: string;
  jobLabels?: string[];
  jobExperience?: string;     // 经验要求，如 "1-3年"
  jobDegree?: string;         // 学历要求，如 "本科"
  skills?: string[];          // 技能标签，如 ["Java", "MySQL", "Spring"]
  welfareList?: string[];     // 福利标签
  lastModifyTime?: number;    // epoch ms
};
