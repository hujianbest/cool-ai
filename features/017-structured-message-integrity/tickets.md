# 浠诲姟绁?鈥?缁撴瀯鍖栨秷鎭畬鏁存€?

- 鐘舵€? 寰?spec-review锛涜崏妗堜笉寰楄繘鍏?implement
- 瑙勬ā: 5 寮犵旱鍚?RED/GREEN 绁紱鍗曚竴鈥渞eopen 鍚庡喕缁撱€佸畬鏁淬€佹棤娉勬紡鈥濈敤鎴风粨鏋?
- 鍏叡缂? `openDatabase(databasePath)`锛汼tructured Message Source Public Read
- TDD: 姣忕エ鍏堜骇鐢熶竴涓叕鍏辫涓?RED锛屽啀浠ユ渶灏?GREEN 闂悎锛涗笉寰楁祴璇曠鏈夊疄鐜版垨寮卞寲鏂█

- [x] T-01 鍐荤粨骞跺叕寮€璇诲彇瀹夊叏 File Reference 鍚嶇О 鈥?Blocked by: None
  - 鍏叡缂? Structured Message Source Public Read銆?
  - RED: 缁忔寮忔彁浜ゅ垱寤?File Reference锛岄殢鍚庢敼鍚嶆潵婧愬苟鍒涘缓 latest 鐗堟湰锛涢娆¤鍙栥€佸啀娆¤鍙栦笌 process reopen 鐩墠杩斿洖鍙彉鍚嶇О鎴栭敊璇増鏈€?
  - GREEN: 鎻愪氦浜嬪姟鍐呭喕缁撹劚鏁忋€乬rapheme 闄愰暱 `publicName` 涓庢槑纭?`sourceEntityVersion`锛沺ublic read 鍙繑鍥炲喕缁?projection锛屼笉 join mutable name銆佷笉鏌?latest銆佷笉鍥為€€璺緞銆?
  - 楠岃瘉: 姝ｅ父/鏁忔劅/杈圭晫 卤1銆佹敼鍚?latest/reopen锛涘搷搴斻€佹棩蹇椾笌 DOM 鏃犵粷瀵硅矾寰?鍑嵁/raw 鍐呭銆?
  - 鍛戒护: `npm test -- tests/structured-message-source-api.test.ts tests/structured-message-reopen.test.ts`锛沗git diff --check`

- [x] T-02 璁?current reopen 绌峰敖 source 涓?state DAG 鈥?Blocked by: T-01
  - 鍏叡缂? `openDatabase(databasePath)`銆?
  - RED: 浠?owner fixture 寤哄悎娉曞浘鍚庡悇鍋氫竴涓?orphan/duplicate/cross-tuple/source-version/head/branch/cycle corruption锛岃瘉鏄庤嚦灏戜竴绫婚潪娉?current 鏁版嵁琚?reopen 鎺ュ彈銆?
  - GREEN: 鐩存帴鏇存柊 `CURRENT_SCHEMA` identity/final manifest/fresh tests锛屽苟鍦ㄤ竴鑷村揩鐓т粠 block/state/source 鍏ㄩ泦鍋氬弻鍚戙€佹伆濂戒竴娆′笌瀹屾暣瀛楁楠岃瘉锛涗笉 migration銆佷笉 repair銆?
  - 楠岃瘉: fresh bootstrap銆乪xact legal reopen銆佹墍鏈夊崟涓€ corruption 绋冲畾鑴辨晱澶辫触涓旀暟鎹簱闆跺啓锛沠ixture 涓嶅鍒跺ぇ鍨?SQL 鍥俱€?
  - 鍛戒护: `npm test -- tests/current-schema.test.ts tests/structured-message-reopen.test.ts`锛沗git diff --check`

- [x] T-03 绌峰敖 completed outcome 骞堕檺鍒?Checklist 鍗曢」鏂瑰悜 鈥?Blocked by: T-02
  - 鍏叡缂? `openDatabase(databasePath)` 涓庢棦鏈?Inline Decision command銆?
  - RED: 鍒嗗埆鏋勯€?completed 缂?澶?Decision銆丷eceipt銆丗act銆佸瓧娈典笉涓€鑷达紝terminal conflict 甯︿笟鍔＄粨鏋滐紝浠ュ強 Checklist 缂虹洰鏍?閿欐柟鍚?澶氶」鎴栧唴瀹规紓绉伙紝璇佹槑褰撳墠 reopen 鎺ュ彈缂哄彛銆?
  - GREEN: operation 鈫?Decision 鈫?Receipt 鈫?Fact 鍏ㄩ泦鍙屽悜涓€瀵逛竴骞堕€愬瓧娈垫牳瀵癸紱鐩搁偦 Checklist state 鍙厑璁哥洰鏍?item checked 浣嶆寜 action 鍚堟硶鏀瑰彉銆?
  - 楠岃瘉: completed 鎭颁竴缁勭粨鏋溿€乻ame-hash replay 鏃犵浜屽姩浣溿€乂ERSION_CONFLICT 闆剁粨鏋滐紱鍚堟硶 check/uncheck 涓庡叏閮ㄩ潪娉?edge 鐭╅樀銆?
  - 鍛戒护: `npm test -- tests/structured-message-reopen.test.ts tests/structured-message-decisions.test.ts`锛沗git diff --check`

- [x] T-04 鏀跺彛 rollback銆丮ission caller 涓?SQLite 閿佸洖褰?鈥?Blocked by: T-03
  - 鍏叡缂? Review 鍏叡浜嬪姟琛屼负銆丮ission create public command銆乣openDatabase`銆?
  - RED: 鍥哄畾 review rollback 鍚庨潪娉?current 鏁版嵁銆? 涓己 `operationId/expectedVersion` 鐨勬棫 caller锛屼互鍙婂凡鐭?busy-timeout锛涙瘡杞彧閫変竴涓け璐ヨ繘鍏?RED/GREEN銆?
  - GREEN: 淇濊瘉 fault 鍏ㄥ洖婊氾紱caller 鏄惧紡涓ユ牸 UUID operation 涓?`expectedVersion=0`锛涘湪 15 鍒嗛挓銆佹渶澶?10 娆″鐜板唴瀹氫綅閿佹寔鏈?杩炴帴鐢熷懡鍛ㄦ湡骞跺仛纭畾鎬ч噴鏀句慨澶嶃€?
  - 楠岃瘉: 涓嶆仮澶嶉粯璁?operation/version锛屼笉澧炲姞鏃犵晫 retry锛屼笉浠ユ墿澶?timeout/skip 鎺╃洊锛涜嫢棰勭畻鍐呮棤鏍瑰洜锛岃褰曞鐜扮巼涓庡仠姝㈣瘉鎹苟鎷嗙エ锛屼笉缁х画寰幆銆?
  - 鍛戒护: 杩愯鍥哄畾澶辫触娓呭崟鐨勮仛鐒?suites锛沗git diff --check`

- [x] T-05 鐪熷疄娴忚鍣ㄤ笌闆嗘垚楠屾敹骞惰В闄ゅ畬鏁存€ч樆濉?鈥?Blocked by: T-04
  - 鍏叡缂? Structured Message Source Public Read 涓庣湡瀹炴祻瑙堝櫒 fact-only transcript銆?
  - RED: browser fixture 鍒涘缓 File Reference 鍚庢敼鍚?reopen锛屽厛璇佹槑椤甸潰鎴栬瘉鎹湭閿佸畾鍐荤粨鍚嶇О涓庨浂娉勬紡缁撴灉銆?
  - GREEN: 浠呰鏃㈡湁 File Reference 灞曠ず娑堣垂鍐荤粨 `publicName`锛涘鐢?Cool tokens/components锛屾棤鏂拌瑙夌郴缁熴€?
  - 楠岃瘉: desktop/narrow銆乴ight/dark 涓悕绉扮ǔ瀹氾紱閿洏涓?axe 鏃?serious/critical锛汥OM/API/log/evidence 鏃犲涓昏矾寰?credential銆傞殢鍚庡彧杩愯涓€娆″彈褰卞搷鍏ㄩ噺娴嬭瘯銆乼ypecheck銆乥uild 涓?`smoke:structured`銆?
  - 鍛戒护: `npm run smoke:structured`锛沗npm test`锛沗npx tsc --noEmit`锛沗npm run build`锛沗git diff --check`
