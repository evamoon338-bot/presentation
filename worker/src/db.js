export async function all(env, sql, ...params) {
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results || [];
}

export async function first(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

export async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

export async function batch(env, statements) {
  return env.DB.batch(statements);
}
