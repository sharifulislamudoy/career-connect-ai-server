// Deterministic Mongo interface double. Set MONGODB_TEST_URI to run the same suite against MongoDB.
const { ObjectId } = require("mongodb");
function copy(v) {
  if (v instanceof Date) return new Date(v);
  if (v instanceof ObjectId) return new ObjectId(v.toHexString());
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
}
function values(obj, path) {
  if (!path.length) return [obj];
  if (Array.isArray(obj)) return obj.flatMap((x) => values(x, path));
  return values(obj?.[path[0]], path.slice(1));
}
const get = (obj, path) => values(obj, path.split("."))[0];
const equal = (a, b) =>
  a instanceof ObjectId || b instanceof ObjectId
    ? String(a) === String(b)
    : a instanceof Date || b instanceof Date
      ? +new Date(a) === +new Date(b)
      : a === b;
function condition(actual, expected) {
  if (
    expected &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    !(expected instanceof Date) &&
    !(expected instanceof ObjectId)
  ) {
    return Object.entries(expected).every(([k, v]) => {
      switch (k) {
        case "$exists":
          return (actual !== undefined) === v;
        case "$gt":
          return actual > v;
        case "$gte":
          return actual >= v;
        case "$lt":
          return actual < v;
        case "$lte":
          return actual <= v;
        case "$ne":
          return !equal(actual, v);
        case "$in":
          return v.some((x) => equal(x, actual));
        case "$nin":
          return !v.some((x) => equal(x, actual));
        case "$regex":
          return new RegExp(v, expected.$options || "").test(
            String(actual || ""),
          );
        case "$options":
          return true;
        case "$type":
          return typeof actual === v;
        default:
          return condition(actual?.[k], v);
      }
    });
  }
  if (expected === null) return actual == null;
  return equal(actual, expected);
}
function match(doc, filter) {
  return Object.entries(filter).every(([k, v]) =>
    k === "$or"
      ? v.some((x) => match(doc, x))
      : k === "$and"
        ? v.every((x) => match(doc, x))
        : values(doc, k.split(".")).some((actual) => condition(actual, v)),
  );
}
function set(doc, key, value) {
  const path = key.split(".");
  let obj = doc;
  for (const k of path.slice(0, -1)) {
    obj[k] ??= {};
    obj = obj[k];
  }
  obj[path.at(-1)] = copy(value);
}
function remove(doc, key) {
  const path = key.split(".");
  let obj = doc;
  for (const k of path.slice(0, -1)) {
    obj = obj?.[k];
    if (!obj) return;
  }
  delete obj[path.at(-1)];
}
function expr(doc, value) {
  if (typeof value === "string" && value.startsWith("$"))
    return get(doc, value.slice(1));
  if (Array.isArray(value)) return value.map((x) => expr(doc, x));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if ("$ifNull" in value) {
      const [a, b] = expr(doc, value.$ifNull);
      return a ?? b;
    }
    if ("$dateToString" in value) {
      return new Intl.DateTimeFormat("sv-SE", {
        timeZone: value.$dateToString.timezone,
        year: "numeric",
        month: "2-digit",
      }).format(expr(doc, value.$dateToString.date));
    }
    if ("$cond" in value) {
      const [a, b, c] = value.$cond;
      return expr(doc, a) ? expr(doc, b) : expr(doc, c);
    }
    if ("$and" in value) return value.$and.every((v) => expr(doc, v));
    if ("$in" in value) {
      const [a, b] = expr(doc, value.$in);
      return b.includes(a);
    }
    if ("$gt" in value) {
      const [a, b] = expr(doc, value.$gt);
      return a > b;
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expr(doc, v)]),
    );
  }
  return value;
}
function project(doc, spec) {
  const include = Object.values(spec).some(
    (v) => v === 1 || typeof v === "object",
  );
  if (include) {
    const out = {};
    if (spec._id !== 0 && doc._id) out._id = doc._id;
    for (const [k, v] of Object.entries(spec))
      if (v === 1) set(out, k, get(doc, k));
      else if (v !== 0) set(out, k, expr(doc, v));
    return out;
  }
  const out = copy(doc);
  for (const k of Object.keys(spec)) remove(out, k);
  return out;
}
function sort(docs, keys) {
  return docs.sort((a, b) => {
    for (const [k, dir] of Object.entries(keys)) {
      const x = get(a, k),
        y = get(b, k);
      if (x > y) return dir;
      if (x < y) return -dir;
    }
    return 0;
  });
}
class Cursor {
  constructor(docs, projection) {
    this.docs = docs;
    this.projection = projection;
  }
  sort(keys) {
    sort(this.docs, keys);
    return this;
  }
  skip(n) {
    this.docs = this.docs.slice(n);
    return this;
  }
  limit(n) {
    this.docs = this.docs.slice(0, n);
    return this;
  }
  async toArray() {
    return this.docs.map((d) =>
      this.projection ? project(d, this.projection) : copy(d),
    );
  }
}
class Collection {
  constructor() {
    this.docs = [];
    this.indexes = [];
  }
  async createIndex(key, opt = {}) {
    this.indexes.push({ key, opt });
    return "index";
  }
  check(doc, ignore) {
    for (const { key, opt } of this.indexes) {
      if (
        !opt.unique ||
        (opt.partialFilterExpression &&
          !match(doc, opt.partialFilterExpression))
      )
        continue;
      if (
        this.docs.some(
          (d) =>
            d !== ignore &&
            Object.keys(key).every((k) => equal(get(doc, k), get(d, k))),
        )
      ) {
        throw Object.assign(new Error("Duplicate key"), { code: 11000 });
      }
    }
  }
  find(filter = {}, options = {}) {
    return new Cursor(
      this.docs.filter((d) => match(d, filter)).map(copy),
      options.projection,
    );
  }
  async findOne(filter = {}, options = {}) {
    const d = this.docs.find((x) => match(x, filter));
    return d
      ? options.projection
        ? project(d, options.projection)
        : copy(d)
      : null;
  }
  async countDocuments(filter = {}) {
    return this.docs.filter((x) => match(x, filter)).length;
  }
  async insertOne(doc) {
    const d = copy(doc);
    d._id ??= new ObjectId();
    this.check(d);
    this.docs.push(d);
    return { insertedId: d._id };
  }
  async insertMany(docs) {
    for (const d of docs) await this.insertOne(d);
    return { insertedCount: docs.length };
  }
  apply(doc, update, filter, insert) {
    for (const [op, fields] of Object.entries(update)) {
      for (let [key, v] of Object.entries(fields)) {
        if (key.includes(".$.")) {
          const array = key.split(".")[0];
          const index = doc[array].findIndex((x) =>
            match(
              x,
              Object.fromEntries(
                Object.entries(filter)
                  .filter(([k]) => k.startsWith(array + "."))
                  .map(([k, v]) => [k.slice(array.length + 1), v]),
              ),
            ),
          );
          key = key.replace(".$.", `.${index}.`);
        }
        if (op === "$set" || (op === "$setOnInsert" && insert))
          set(doc, key, v);
        if (op === "$unset") remove(doc, key);
        if (op === "$inc") set(doc, key, (get(doc, key) || 0) + v);
        if (op === "$pull")
          set(
            doc,
            key,
            (get(doc, key) || []).filter((x) => !match(x, v)),
          );
      }
    }
  }
  async updateOne(filter, update, options = {}) {
    let d = this.docs.find((x) => match(x, filter));
    const inserted = !d;
    if (!d && !options.upsert)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    if (!d) {
      d = Object.fromEntries(
        Object.entries(filter).filter(
          ([k, v]) =>
            !k.startsWith("$") &&
            !(v && typeof v === "object" && !(v instanceof ObjectId)),
        ),
      );
      d._id ??= new ObjectId();
    }
    const candidate = copy(d);
    this.apply(candidate, update, filter, inserted);
    this.check(candidate, inserted ? undefined : d);
    if (inserted) this.docs.push(candidate);
    else Object.assign(d, candidate);
    if (!inserted)
      for (const key of Object.keys(d)) if (!(key in candidate)) delete d[key];
    return {
      matchedCount: inserted ? 0 : 1,
      modifiedCount: 1,
      upsertedCount: inserted ? 1 : 0,
      upsertedId: inserted ? candidate._id : undefined,
    };
  }
  async findOneAndUpdate(filter, update, options = {}) {
    const stored = this.docs.find((x) => match(x, filter));
    let old = stored ? copy(stored) : null;
    if (!stored && !options.upsert) return null;
    await this.updateOne(filter, update, options);
    if (options.returnDocument === "before") return old;
    return this.findOne(
      old
        ? { _id: old._id }
        : Object.fromEntries(
            Object.entries(filter).filter(
              ([k, v]) =>
                !k.startsWith("$") &&
                !(v && typeof v === "object" && !(v instanceof ObjectId)),
            ),
          ),
    );
  }
  async deleteOne(filter) {
    const i = this.docs.findIndex((d) => match(d, filter));
    if (i < 0) return { deletedCount: 0 };
    this.docs.splice(i, 1);
    return { deletedCount: 1 };
  }
  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !match(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async updateMany(filter, update) {
    for (const d of [...this.docs].filter((d) => match(d, filter)))
      await this.updateOne({ _id: d._id }, update);
  }
  aggregate(pipeline) {
    let docs = this.docs.map(copy);
    for (const stage of pipeline) {
      if (stage.$match) docs = docs.filter((d) => match(d, stage.$match));
      if (stage.$project) docs = docs.map((d) => project(d, stage.$project));
      if (stage.$sort) sort(docs, stage.$sort);
      if (stage.$group) {
        const groups = new Map();
        for (const d of docs) {
          const key = expr(d, stage.$group._id);
          const h = JSON.stringify(key);
          const row = groups.get(h) || { _id: key };
          for (const [k, v] of Object.entries(stage.$group))
            if (k !== "_id" && v.$sum !== undefined)
              row[k] = (row[k] || 0) + (Number(expr(d, v.$sum)) || 0);
          groups.set(h, row);
        }
        docs = [...groups.values()];
      }
      if (stage.$count)
        docs = docs.length ? [{ [stage.$count]: docs.length }] : [];
    }
    return new Cursor(docs);
  }
}
class MemoryDb {
  constructor() {
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name))
      this.collections.set(name, new Collection());
    return this.collections.get(name);
  }
  async dropDatabase() {
    this.collections.clear();
  }
}
module.exports = { MemoryDb };
