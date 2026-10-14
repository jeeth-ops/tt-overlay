// A small in-memory MongoDB for tests that exercise code against the real
// driver API surface: dotted paths (through arrays), the common query and
// update operators, upserts, bulkWrite and UNIQUE indexes — including the
// multikey rules (an array field indexes each element; an empty array
// indexes as one "undefined" key, so two docs with [] collide).
// Every read returns a copy, every write stores a copy, so a test can never
// pass because code mutated a returned document in place.
const { ObjectId } = require('mongodb');

function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof ObjectId || v._bsontype) return v;
    if (Array.isArray(v)) return v.map(clone);
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = clone(v[k]);
    return o;
}
const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId) && !v._bsontype;
const sameVal = (a, b) => {
    if (a instanceof ObjectId || b instanceof ObjectId) return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (a && typeof a === 'object' && b && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
};

// All values reached by a dotted path, descending into arrays.
function valuesAt(doc, path) {
    const parts = path.split('.');
    let cur = [doc];
    for (const p of parts) {
        const next = [];
        for (const c of cur) {
            if (c == null) { next.push(undefined); continue; }
            if (Array.isArray(c)) {
                if (/^\d+$/.test(p)) { next.push(c[Number(p)]); continue; }
                c.forEach(el => next.push(el == null ? undefined : el[p]));
                continue;
            }
            next.push(typeof c === 'object' ? c[p] : undefined);
        }
        cur = next;
    }
    return cur;
}
const expand = (vals) => vals.flatMap(v => Array.isArray(v) ? [v, ...v] : [v]);

function cmp(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (a instanceof Date) a = a.getTime();
    if (b instanceof Date) b = b.getTime();
    return a < b ? -1 : a > b ? 1 : 0;
}

function matchCond(vals, cond) {
    const all = expand(vals);
    if (isPlainObj(cond) && Object.keys(cond).some(k => k.startsWith('$'))) {
        return Object.keys(cond).every(op => {
            const v = cond[op];
            switch (op) {
                case '$eq': return all.some(x => sameVal(x, v));
                case '$ne': return !all.some(x => (v === null ? x == null : sameVal(x, v)));
                case '$in': return v.some(t => t === null ? all.some(x => x == null) : all.some(x => sameVal(x, t)));
                case '$nin': return !v.some(t => t === null ? all.some(x => x == null) : all.some(x => sameVal(x, t)));
                case '$exists': return v ? vals.some(x => x !== undefined) : vals.every(x => x === undefined);
                case '$gt': return all.some(x => x != null && cmp(x, v) > 0);
                case '$gte': return all.some(x => x != null && cmp(x, v) >= 0);
                case '$lt': return all.some(x => x != null && cmp(x, v) < 0);
                case '$lte': return all.some(x => x != null && cmp(x, v) <= 0);
                case '$type': return all.some(x => (v === 'string' ? typeof x === 'string' : true));
                case '$size': return vals.some(x => Array.isArray(x) && x.length === v);
                case '$not': return !matchCond(vals, v);
                case '$regex': { const re = v instanceof RegExp ? v : new RegExp(v, cond.$options || ''); return all.some(x => typeof x === 'string' && re.test(x)); }
                case '$options': return true;
                default: throw new Error('mongo-memory: unsupported operator ' + op);
            }
        });
    }
    if (cond === null) return vals.every(x => x == null) || all.some(x => x === null);
    return all.some(x => sameVal(x, cond));
}
function matches(doc, q) {
    return Object.keys(q || {}).every(k => {
        const v = q[k];
        if (k === '$or') return v.some(sub => matches(doc, sub));
        if (k === '$and') return v.every(sub => matches(doc, sub));
        if (k === '$nor') return !v.some(sub => matches(doc, sub));
        return matchCond(valuesAt(doc, k), v);
    });
}

// ---- updates ----
function setPath(doc, path, value) {
    const parts = path.split('.');
    let cur = doc;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = clone(value);
}
function getPath(doc, path) {
    return path.split('.').reduce((c, p) => (c == null ? undefined : c[p]), doc);
}
function unsetPath(doc, path) {
    const parts = path.split('.');
    const parent = parts.slice(0, -1).reduce((c, p) => (c == null ? undefined : c[p]), doc);
    if (parent && typeof parent === 'object') delete parent[parts[parts.length - 1]];
}
function applyUpdate(doc, update, isInsert) {
    const ops = Object.keys(update);
    if (!ops.every(o => o.startsWith('$'))) throw new Error('mongo-memory: update must use operators');
    for (const op of ops) {
        const fields = update[op];
        for (const path of Object.keys(fields)) {
            const v = fields[path];
            switch (op) {
                case '$set': setPath(doc, path, v); break;
                case '$setOnInsert': if (isInsert) setPath(doc, path, v); break;
                case '$unset': unsetPath(doc, path); break;
                case '$inc': setPath(doc, path, (Number(getPath(doc, path)) || 0) + v); break;
                case '$push': {
                    const arr = getPath(doc, path);
                    const list = Array.isArray(arr) ? arr.slice() : [];
                    if (isPlainObj(v) && Array.isArray(v.$each)) list.push(...clone(v.$each)); else list.push(clone(v));
                    setPath(doc, path, list);
                    break;
                }
                case '$addToSet': {
                    const arr = getPath(doc, path);
                    const list = Array.isArray(arr) ? arr.slice() : [];
                    const items = isPlainObj(v) && Array.isArray(v.$each) ? v.$each : [v];
                    items.forEach(it => { if (!list.some(x => sameVal(x, it))) list.push(clone(it)); });
                    setPath(doc, path, list);
                    break;
                }
                case '$pull': {
                    const arr = getPath(doc, path);
                    if (!Array.isArray(arr)) break;
                    const keep = arr.filter(el => isPlainObj(v) ? !matches(el, v) : !sameVal(el, v));
                    setPath(doc, path, keep);
                    break;
                }
                default: throw new Error('mongo-memory: unsupported update operator ' + op);
            }
        }
    }
}
function seedFromFilter(filter) {
    const d = {};
    Object.keys(filter || {}).forEach(k => {
        const v = filter[k];
        if (k.startsWith('$')) return;
        if (isPlainObj(v) && Object.keys(v).some(x => x.startsWith('$'))) {
            if ('$eq' in v) setPath(d, k, v.$eq);
            return;
        }
        setPath(d, k, v);
    });
    return d;
}

class DuplicateKeyError extends Error {
    constructor(msg) { super(msg); this.code = 11000; }
}

class Collection {
    constructor(name, db) {
        this.name = name;
        this.db = db;
        this.docs = [];
        this.indexes = [];
    }
    _fail(op, arg) {
        const f = this.db.faults.find(x => (x.coll === this.name || x.coll === '*') && x.op === op && (x.times == null || x.times > 0) && (!x.when || x.when(arg)));
        if (f) {
            if (f.times != null) f.times--;
            throw new Error(`injected failure: ${this.name}.${op}`);
        }
    }
    _keysOf(doc, idx) {
        const fields = Object.keys(idx.spec);
        const perField = fields.map(f => {
            const vals = valuesAt(doc, f);
            const v = vals.length === 1 ? vals[0] : vals.flat();
            if (v === undefined) return [null];
            if (Array.isArray(v)) return v.length ? v.map(x => x === undefined ? null : x) : ['__undefined__'];
            return [v];
        });
        if (idx.sparse && fields.every(f => valuesAt(doc, f).every(x => x === undefined))) return [];
        let combos = [[]];
        perField.forEach(vals => { combos = combos.flatMap(c => vals.map(v => c.concat([v instanceof ObjectId ? 'oid:' + v.toHexString() : v]))); });
        return combos.map(c => JSON.stringify(c));
    }
    _checkUnique(doc, ignoreId) {
        for (const idx of this.indexes) {
            if (!idx.unique) continue;
            const mine = new Set(this._keysOf(doc, idx));
            if (!mine.size) continue;
            for (const other of this.docs) {
                if (ignoreId !== undefined && sameVal(other._id, ignoreId)) continue;
                if (this._keysOf(other, idx).some(k => mine.has(k))) throw new DuplicateKeyError(`E11000 duplicate key error collection: ${this.name} index: ${idx.name}`);
            }
        }
        if (doc._id !== undefined) {
            for (const other of this.docs) {
                if (ignoreId !== undefined && sameVal(other._id, ignoreId)) continue;
                if (sameVal(other._id, doc._id)) throw new DuplicateKeyError(`E11000 duplicate key error collection: ${this.name} index: _id_`);
            }
        }
    }
    async createIndex(spec, opts) {
        opts = opts || {};
        const name = Object.keys(spec).map(k => k + '_' + spec[k]).join('_');
        if (!this.indexes.some(i => i.name === name)) this.indexes.push({ name, spec, unique: !!opts.unique, sparse: !!opts.sparse });
        return name;
    }
    find(q) {
        let rows = this.docs.filter(d => matches(d, q || {}));
        const cur = {
            sort: (s) => {
                const ks = Object.keys(s);
                rows = rows.slice().sort((a, b) => { for (const k of ks) { const c = cmp(getPath(a, k), getPath(b, k)) * s[k]; if (c) return c; } return 0; });
                return cur;
            },
            skip: (n) => { rows = rows.slice(n); return cur; },
            limit: (n) => { if (n) rows = rows.slice(0, n); return cur; },
            project: () => cur,
            toArray: async () => { this._fail('find', q); return rows.map(clone); },
            next: async () => { const r = rows.shift(); return r ? clone(r) : null; },
            hasNext: async () => rows.length > 0,
        };
        return cur;
    }
    async findOne(q) {
        this._fail('findOne', q);
        const d = this.docs.find(x => matches(x, q || {}));
        return d ? clone(d) : null;
    }
    async countDocuments(q) {
        return this.docs.filter(d => matches(d, q || {})).length;
    }
    // Only what server.js's start-up clean-up asks for; it finds nothing here.
    aggregate() {
        return { toArray: async () => [] };
    }
    async insertOne(doc) {
        this._fail('insertOne', doc);
        const d = clone(doc);
        if (d._id === undefined) d._id = new ObjectId();
        this._checkUnique(d);
        this.docs.push(d);
        if (doc._id === undefined) doc._id = d._id;
        return { insertedId: d._id, acknowledged: true };
    }
    async insertMany(docs, opts) {
        const ordered = !opts || opts.ordered !== false;
        let n = 0, err = null;
        for (const doc of docs) {
            try { await this.insertOne(doc); n++; } catch (e) { err = err || e; if (ordered) break; }
        }
        if (err) { err.insertedCount = n; throw err; }
        return { insertedCount: n };
    }
    async updateOne(filter, update, opts) {
        this._fail('updateOne', filter);
        const i = this.docs.findIndex(d => matches(d, filter || {}));
        if (i < 0) {
            if (!(opts && opts.upsert)) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
            const d = seedFromFilter(filter);
            applyUpdate(d, update, true);
            if (d._id === undefined) d._id = new ObjectId();
            this._checkUnique(d);
            this.docs.push(d);
            return { matchedCount: 0, modifiedCount: 0, upsertedId: d._id, upsertedCount: 1 };
        }
        const next = clone(this.docs[i]);
        applyUpdate(next, update, false);
        this._checkUnique(next, this.docs[i]._id);
        const changed = JSON.stringify(next) !== JSON.stringify(this.docs[i]);
        this.docs[i] = next;
        return { matchedCount: 1, modifiedCount: changed ? 1 : 0, upsertedId: null };
    }
    async updateMany(filter, update) {
        this._fail('updateMany', filter);
        let n = 0;
        for (let i = 0; i < this.docs.length; i++) {
            if (!matches(this.docs[i], filter || {})) continue;
            const next = clone(this.docs[i]);
            applyUpdate(next, update, false);
            this._checkUnique(next, this.docs[i]._id);
            this.docs[i] = next;
            n++;
        }
        return { matchedCount: n, modifiedCount: n };
    }
    async replaceOne(filter, doc, opts) {
        this._fail('replaceOne', filter);
        const i = this.docs.findIndex(d => matches(d, filter || {}));
        const rep = clone(doc);
        if (i < 0) {
            if (!(opts && opts.upsert)) return { matchedCount: 0, modifiedCount: 0 };
            const seed = seedFromFilter(filter);
            const d = Object.assign({}, rep);
            if (d._id === undefined) d._id = seed._id !== undefined ? seed._id : new ObjectId();
            this._checkUnique(d);
            this.docs.push(d);
            return { matchedCount: 0, modifiedCount: 0, upsertedId: d._id, upsertedCount: 1 };
        }
        if (rep._id !== undefined && !sameVal(rep._id, this.docs[i]._id)) throw new Error('mongo-memory: replaceOne may not change _id');
        rep._id = this.docs[i]._id;
        this._checkUnique(rep, this.docs[i]._id);
        this.docs[i] = rep;
        return { matchedCount: 1, modifiedCount: 1 };
    }
    async deleteOne(filter) {
        this._fail('deleteOne', filter);
        const i = this.docs.findIndex(d => matches(d, filter || {}));
        if (i >= 0) this.docs.splice(i, 1);
        return { deletedCount: i >= 0 ? 1 : 0 };
    }
    async deleteMany(filter) {
        this._fail('deleteMany', filter);
        const before = this.docs.length;
        this.docs = this.docs.filter(d => !matches(d, filter || {}));
        return { deletedCount: before - this.docs.length };
    }
    async bulkWrite(ops, opts) {
        this._fail('bulkWrite', ops);
        const ordered = !opts || opts.ordered !== false;
        let err = null;
        for (const op of ops) {
            try {
                if (op.insertOne) await this.insertOne(op.insertOne.document);
                else if (op.updateOne) await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
                else if (op.updateMany) await this.updateMany(op.updateMany.filter, op.updateMany.update);
                else if (op.replaceOne) await this.replaceOne(op.replaceOne.filter, op.replaceOne.replacement, { upsert: op.replaceOne.upsert });
                else if (op.deleteOne) await this.deleteOne(op.deleteOne.filter);
                else if (op.deleteMany) await this.deleteMany(op.deleteMany.filter);
            } catch (e) { err = err || e; if (ordered) break; }
        }
        if (err) throw err;
        return { ok: 1 };
    }
}

class MemoryDb {
    constructor() { this.colls = new Map(); this.faults = []; }
    collection(name) {
        if (!this.colls.has(name)) this.colls.set(name, new Collection(name, this));
        return this.colls.get(name);
    }
    // fail(coll|'*', op, { times, when }) — the next matching call throws
    fail(coll, op, opts) { this.faults.push(Object.assign({ coll, op }, opts || {})); }
    clearFaults() { this.faults = []; }
}

module.exports = { MemoryDb, ObjectId, matches, valuesAt, DuplicateKeyError };
