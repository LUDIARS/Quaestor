/**
 * 初期 seed データ。 calc/spec/account-codes.md と同じ内容。
 * DB 起動時に「account_codes が空なら」 seed する (冪等)。
 */

export type AccountKind = "revenue" | "expense" | "asset" | "liability";

export interface SeedAccount {
  code: number;
  name: string;
  kind: AccountKind;
}

export const SEED_ACCOUNTS: SeedAccount[] = [
  { code: 1, name: "売上（収入）", kind: "revenue" },
  { code: 10, name: "水道光熱費", kind: "expense" },
  { code: 11, name: "旅費交通費", kind: "expense" },
  { code: 12, name: "通信費", kind: "expense" },
  { code: 14, name: "接待交際費", kind: "expense" },
  { code: 17, name: "消耗品費", kind: "expense" },
  { code: 23, name: "地代家賃", kind: "expense" },
  { code: 25, name: "新聞図書費", kind: "expense" },
  { code: 26, name: "ソフトウエア購入費", kind: "expense" },
  { code: 28, name: "会議費", kind: "expense" },
  { code: 101, name: "現金", kind: "asset" },
  { code: 102, name: "当座預金", kind: "asset" },
  { code: 106, name: "売掛金", kind: "asset" },
  { code: 117, name: "仮払税金", kind: "asset" },
  { code: 124, name: "事業主貸", kind: "asset" },
  { code: 172, name: "事業主借", kind: "liability" },
];

/**
 * 按分率ルール初期 seed。 priority は **小さいほど優先**。
 * pattern は regex (i flag 既定で付与)、 全角・半角両対応の表現を入れている。
 *
 * 詳細出典: spec/account-codes.md。 calc/convert-all-with-rate.js RATE_RULES を移植。
 */
export interface SeedRule {
  pattern: string;
  rate: number;
  code: number;
  priority: number;
  note?: string;
}

export const SEED_RULES: SeedRule[] = [
  // 100% 経費 — クラウド / SaaS
  { pattern: "AMAZON\\s*WEB\\s*SERV|ＡＭＡＺＯＮ　ＷＥＢ　ＳＥＲＶ", rate: 1.0, code: 26, priority: 10, note: "AWS" },
  { pattern: "PAYPAL.*MICROSOFT|ＰＡＹＰＡＬ.*ＭＩＣＲＯＳＯ", rate: 1.0, code: 26, priority: 11, note: "Microsoft via PayPal" },
  { pattern: "NOTION", rate: 1.0, code: 26, priority: 12 },
  { pattern: "OPENAI|CHATGPT|ANTHROPIC|CLAUDE\\.AI", rate: 1.0, code: 26, priority: 13, note: "AI APIs" },
  { pattern: "UNITY|STEAM|HUMBLEBUNDLE|ADOBE", rate: 1.0, code: 26, priority: 14 },
  { pattern: "GOOGLE.*WORKSPACE|GOOGLE.*GSUITE", rate: 1.0, code: 26, priority: 15 },
  { pattern: "CODERABBIT|LOUDLY|INKNOE", rate: 1.0, code: 26, priority: 16 },
  { pattern: "CTW株式会社|ＣＴＷ株式会社", rate: 1.0, code: 26, priority: 17 },
  { pattern: "MIXI（モンスト）|ＭＩＸＩ（モンスト）", rate: 1.0, code: 26, priority: 18 },
  { pattern: "ヨドバシカメラ", rate: 1.0, code: 26, priority: 19 },
  { pattern: "ラクスル", rate: 1.0, code: 26, priority: 20 },
  { pattern: "お名前\\.com|お名前．ｃｏｍ", rate: 1.0, code: 26, priority: 21 },
  { pattern: "ニンテンドー[EＥ][シシ]ョ?[ップツ]+", rate: 1.0, code: 26, priority: 22 },
  { pattern: "APPLE COM BILL|ＡＰＰＬＥ　ＣＯＭ　ＢＩＬＬ", rate: 1.0, code: 26, priority: 23 },

  // 100% 会議費 — 飲食
  { pattern: "ミクシィ社員食堂", rate: 1.0, code: 28, priority: 30 },
  { pattern: "すぱじろう", rate: 1.0, code: 28, priority: 31 },
  { pattern: "サイゼリヤ", rate: 1.0, code: 28, priority: 32 },
  { pattern: "世界の山ちゃん", rate: 1.0, code: 28, priority: 33 },
  { pattern: "鳥元", rate: 1.0, code: 28, priority: 34 },
  { pattern: "牛角", rate: 1.0, code: 28, priority: 35 },
  { pattern: "焼ジビエ.*罠|焼ジビエ\\s*罠", rate: 1.0, code: 28, priority: 36 },
  { pattern: "馬肉酒場.*三村", rate: 1.0, code: 28, priority: 37 },
  { pattern: "椿屋珈琲", rate: 1.0, code: 28, priority: 38 },
  { pattern: "バルバッコア", rate: 1.0, code: 28, priority: 39 },
  { pattern: "インド料理.*スーリヤ", rate: 1.0, code: 28, priority: 40 },

  // 70% 通信費
  { pattern: "AU電話利用料|ａｕ電話利用料|au携帯電話料金|ＡＵ携帯電話料金", rate: 0.7, code: 12, priority: 50, note: "au mobile" },

  // 60% 新聞図書費
  { pattern: "AMAZON\\s*DOWNLOAD|Ａｍａｚｏｎ\\s*Ｄｏｗｎｌｏａｄ|ＡＭＡＺＯＮ　ＤＯＷＮＬＯＡＤ", rate: 0.6, code: 25, priority: 60 },

  // 50% 娯楽サブスク
  { pattern: "NETFLIX|ＮＥＴＦＬＩＸ|ネットフリックス|ネツトフリツクス", rate: 0.5, code: 26, priority: 70 },
  { pattern: "GLOBALWIFI|グローバルＷｉＦｉ", rate: 0.5, code: 26, priority: 71 },

  // 30% NHK
  { pattern: "NHK|ＮＨＫ", rate: 0.3, code: 26, priority: 80 },

  // 20% Amazon プライム
  { pattern: "AMAZONプライム|Ａｍａｚｏｎプライム|Ａｍａｚｏｎ\\s*プライム", rate: 0.2, code: 26, priority: 90 },

  // 10% 水道
  { pattern: "水道料金", rate: 0.1, code: 10, priority: 100 },
];

/**
 * payee 文字列から match する rule を返す。 マッチしなければ null。
 * 呼び出し側は一覧 (priority 順) を渡す。 ロジックを純関数にしておくとテストしやすい。
 */
export function matchRule<T extends { pattern: string; priority: number }>(
  rules: T[],
  normalizedPayee: string,
): T | null {
  // 既に priority asc でソート済前提だが、 念のため安定 sort
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const r of sorted) {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, "i");
    } catch {
      continue;
    }
    if (re.test(normalizedPayee)) return r;
  }
  return null;
}
