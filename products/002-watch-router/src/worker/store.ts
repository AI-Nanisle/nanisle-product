// Store 的选择逻辑:AWS 三件套配齐 → DynamoDB(线上),否则内存替身
// (本地 dev / fork 零配置)。/api/health 会把当前模式回显出来——内存和
// 线上长得一模一样,不标出来就会把本地状态当成已上线。

import { DdbStore, MemoryStore } from "../shared/store";
import type { Store } from "../shared/store";
import { awsConfigured } from "./env";
import type { AppEnv } from "./env";

export type StoreMode = "dynamo" | "memory";

// 内存替身必须是模块级单例:makeStore 在门禁中间件里每请求调一次,
// 每次 new 的话任务/配额活不过单次请求——「提交完轮询 404」就是这么来的
// (实测踩过)。同一 isolate 内共享一份;isolate 回收丢状态,dev 场景可接受。
const memory = new MemoryStore();

export function makeStore(env: AppEnv): { store: Store; mode: StoreMode } {
	if (awsConfigured(env)) {
		return {
			store: new DdbStore({
				accessKeyId: env.AWS_ACCESS_KEY_ID!,
				secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
				table: env.DDB_TABLE!,
				region: env.AWS_REGION ?? "us-east-1",
			}),
			mode: "dynamo",
		};
	}
	return { store: memory, mode: "memory" };
}
