/**
 * シークレット登録 CLI (secret-store.ts のフロント)。
 *
 *   npm run secret -- set ANTHROPIC_API_KEY sk-ant-xxxx
 *   npm run secret -- list
 *   npm run secret -- remove ANTHROPIC_API_KEY
 *
 * 値は AES-256-GCM で app_data/secrets.enc.json に保存される (平文保存しない)。
 * 鍵は ~/.quaestor/secret.key (本体と分離)。
 */

import { SecretStore } from "../services/secret-store.js";

function main(argv: string[]): number {
  const [cmd, name, value] = argv;
  const store = new SecretStore();

  switch (cmd) {
    case "set": {
      if (!name || !value) { usage(); return 1; }
      store.set(name, value);
      console.log(`saved: ${name} (encrypted)`);
      return 0;
    }
    case "list": {
      const names = store.names();
      console.log(names.length > 0 ? names.join("\n") : "(empty)");
      return 0;
    }
    case "remove": {
      if (!name) { usage(); return 1; }
      console.log(store.remove(name) ? `removed: ${name}` : `not found: ${name}`);
      return 0;
    }
    default:
      usage();
      return 1;
  }
}

function usage(): void {
  console.log("usage: npm run secret -- <set NAME VALUE | list | remove NAME>");
}

process.exit(main(process.argv.slice(2)));
