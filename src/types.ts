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
  cityName: string;
  areaDistrict?: string;
  salaryDesc: string;
  jobLabels?: string[];
  experienceName?: string;
  degreeName?: string;
  lastModifyTime?: number;    // epoch ms
  publishTime?: string;       // human readable
};
