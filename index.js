/* zero-dependency
 * Vanilla JS Implementation of SharedMap,
 * a synchronous multi-threading capable,
 * fine-grained locked with deadlock recovery,
 * static memory allocated,
 * coalesced-chaining HashMap,
 * backed by SharedArrayBuffer
 * that supports deleting
 * and is capable of auto-defragmenting itself on delete unless almost full
 * 
 * compatible with both Node.js and SharedArrayBuffer-enabled browsers
 * @author <a href="mailto:momtchil@momtchev.com">Momtchil Momtchev</a>
 * @see http://github.com/mmomtchev/SharedMap
 */

const UINT32_UNDEFINED = 0xFFFFFFFF;
/* This is MurmurHash2 */
function _hash(str) {
    var
        l = str.length,
        h = 17 ^ l,
        i = 0,
        k;
    while (l >= 4) {
        k =
            ((str.charCodeAt(i) & 0xff)) |
            ((str.charCodeAt(++i) & 0xff) << 8) |
            ((str.charCodeAt(++i) & 0xff) << 16) |
            ((str.charCodeAt(++i) & 0xff) << 14);
        k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
        k ^= k >>> 14;
        k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
        h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16)) ^ k;
        l -= 4;
        ++i;
    }
    /* eslint-disable no-fallthrough */
    switch (l) {
        case 3: h ^= (str.charCodeAt(i + 2) & 0xff) << 16;
        case 2: h ^= (str.charCodeAt(i + 1) & 0xff) << 8;
        case 1: h ^= (str.charCodeAt(i) & 0xff);
            h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
    }
    /* eslint-enable no-fallthrough */
    h ^= h >>> 13;
    h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
    h ^= h >>> 15;
    return h >>> 0;
}

function align32(v) {
    return (v & 0xFFFFFFFFFFFFC) + ((v & 0x3) ? 0x4 : 0);
}

const META = {
    maxSize: 0,
    keySize: 1,
    objSize: 2,
    length: 3
};

const LOCK = {
    SHARED: 0,
    EXCLUSIVE: 1,
    READERS: 2
};

class Deadlock extends Error {
    constructor(...params) {
        super(...params);
    }
}

class SharedMap {
    constructor(maxSize, keySize, objSize) {
        maxSize = align32(maxSize);
        keySize = align32(keySize);
        objSize = align32(objSize);

        if (!(maxSize > 0 && keySize > 0 && objSize > 0))
            throw new RangeError('maxSize, keySize and objSize must be positive numbers');
        this.storage = new SharedArrayBuffer(
            Object.keys(META).length * Uint32Array.BYTES_PER_ELEMENT
            + (keySize + objSize) * maxSize * Uint16Array.BYTES_PER_ELEMENT
            + maxSize * Uint32Array.BYTES_PER_ELEMENT
            + Math.ceil(maxSize / 32) * Int32Array.BYTES_PER_ELEMENT
            + Object.keys(LOCK).length * Int32Array.BYTES_PER_ELEMENT);

        let offset = 0;
        this.meta = new Uint32Array(this.storage, offset, Object.keys(META).length);
        offset += this.meta.byteLength;
        this.meta[META.maxSize] = maxSize;
        this.meta[META.keySize] = keySize;
        this.meta[META.objSize] = objSize;
        this.meta[META.length] = 0;
        this.keysData = new Uint16Array(this.storage, offset, this.meta[META.keySize] * this.meta[META.maxSize]);
        offset += this.keysData.byteLength;
        this.valuesData = new Uint16Array(this.storage, offset, this.meta[META.objSize] * this.meta[META.maxSize]);
        offset += this.valuesData.byteLength;
        this.chaining = new Uint32Array(this.storage, offset, this.meta[META.maxSize]);
        offset += this.chaining.byteLength;
        this.linelocks = new Int32Array(this.storage, offset, Math.ceil(maxSize / 32));
        offset += this.linelocks.byteLength;
        this.maplock = new Int32Array(this.storage, offset, Object.keys(LOCK).length);
        this.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, deadlock: 0 };
    }

    get length() {
        /* We do not hold a lock here */
        return Atomics.load(this.meta, META.length);
    }

    get size() {
        return this.meta[META.maxSize];
    }

    _lock(l) {
        /* eslint-disable no-constant-condition */
        while (true) {
            let state;
            state = Atomics.exchange(this.maplock, l, 1);
            if (state == 0)
                return;
            Atomics.wait(this.maplock, l, state);
        }
        /* eslint-enable no-constant-condition */
    }

    _unlock(l) {
        const state = Atomics.exchange(this.maplock, l, 0);
        if (state == 0)
            throw new Error('maplock desync ' + l);
        Atomics.notify(this.maplock, l);
    }

    lockLine(pos) {
        const bitmask = 1 << (pos % 32);
        const index = Math.floor(pos / 32);
        while (true) {
            const state = Atomics.or(this.linelocks, index, bitmask);
            if ((state & bitmask) == 0)
                return pos;
            Atomics.wait(this.linelocks, index, state);
        }
    }

    unlockLine(pos) {
        const bitmask = 1 << (pos % 32);
        const notbitmask = (~bitmask) & 0xFFFFFFFF;
        const index = Math.floor(pos / 32);
        const state = Atomics.and(this.linelocks, index, notbitmask);
        if ((state & bitmask) == 0)
            throw new Error('linelock desync ' + pos);
        Atomics.notify(this.linelocks, index);
    }

    /*unlockLines(locks) {
        for (let l of locks)
            this.unlockLine(l);
    }*/

    lockLineSliding(oldLock, newLock) {
        if (newLock <= oldLock)
            throw new Deadlock();
        this.lockLine(newLock);
        this.unlockLine(oldLock);
        return newLock;
    }

    assertLocked(pos) {
        const bitmask = 1 << (pos % 32);
        const index = Math.floor(pos / 32);
        if (this.linelocks[index] && bitmask === 0)
            throw 'Not locked';
    }

    lockMapExclusive() {
        this._lock(LOCK.EXCLUSIVE);
    }

    unlockMapExclusive() {
        this._unlock(LOCK.EXCLUSIVE);
    }

    lockMapShared() {
        this._lock(LOCK.SHARED);
        if (++this.maplock[LOCK.READERS] == 1)
            this._lock(LOCK.EXCLUSIVE);
        this._unlock(LOCK.SHARED);
    }

    unlockMapShared() {
        this._lock(LOCK.SHARED);
        if (--this.maplock[LOCK.READERS] == 0)
            this._unlock(LOCK.EXCLUSIVE);
        this._unlock(LOCK.SHARED);
    }

    _match(key, pos) {
        let i;
        for (i = 0; i < key.length; i++)
            if (this.keysData[pos * this.meta[META.keySize] + i] !== key.charCodeAt(i))
                break;
        return i === key.length && this.keysData[pos * this.meta[META.keySize] + i] === 0;
    }

    _decodeValue(pos) {
        const eos = this.valuesData.subarray(pos * this.meta[META.objSize], (pos + 1) * this.meta[META.objSize]).findIndex(x => x === 0);
        const end = eos < 0 ? (pos + 1) * this.meta[META.objSize] : pos * this.meta[META.objSize] + eos;
        return String.fromCharCode.apply(null, this.valuesData.subarray(pos * this.meta[META.objSize], end));
    }

    _decodeKey(pos) {
        const eos = this.keysData.subarray(pos * this.meta[META.keySize], (pos + 1) * this.meta[META.keySize]).findIndex(x => x === 0);
        const end = eos < 0 ? (pos + 1) * this.meta[META.keySize] : pos * this.meta[META.keySize] + eos;
        return String.fromCharCode.apply(null, this.keysData.subarray(pos * this.meta[META.keySize], end));
    }

    /* These are debugging aids */
    _decodeBucket(pos, n) {
        return `pos: ${pos}`
            + ` hash: ${this._hash(this._decodeKey(pos))}`
            + ` key: ${this._decodeKey(pos)}`
            + ` value: ${this._decodeValue(pos)}`
            + ` chain: ${this.chaining[pos]}`
            + ((n > 0 && this.chaining[pos] !== UINT32_UNDEFINED) ? '\n' + (this._decodeBucket(this.chaining[pos], n - 1)) : '');
    }
    __printMap() {
        for (let i = 0; i < this.meta[META.maxSize]; i++)
            console.log(this._decodeBucket(i, 0));
        process.exit(1);
    }

    _set(key, value, exclusive) {
        /* Hash */
        let pos = this._hash(key);
        /* Find the first free bucket, remembering the last occupied one to chain it */
        let toChain;
        let slidingLock;
        exclusive || (slidingLock = this.lockLine(pos, exclusive));
        try {
            while (this.keysData[pos * this.meta[META.keySize]] !== 0) {
                this.stats.collisions++;
                /* Replacing existing key */
                if (this._match(key, pos)) {
                    for (let i = 0; i < value.length; i++)
                        this.valuesData[pos * this.meta[META.objSize] + i] = value.charCodeAt(i);
                    exclusive || this.unlockLine(slidingLock);
                    return;
                }
                if (this.chaining[pos] === UINT32_UNDEFINED || toChain !== undefined) {
                    /* This is the last collision element, we will chain ourselves to it */
                    if (toChain == undefined) {
                        toChain = pos;
                        pos = (pos + 1) % this.meta[META.maxSize];
                        exclusive || (slidingLock = this.lockLine(pos));
                    } else {
                        /* Now lets find the first free position (or a match of a preexising key) */
                        pos = (pos + 1) % this.meta[META.maxSize];
                        exclusive || (slidingLock = this.lockLineSliding(slidingLock, pos));
                    }
                } else {
                    /* We are following the collision chain here */
                    pos = this.chaining[pos];
                    exclusive || (slidingLock = this.lockLineSliding(slidingLock, pos));
                }
            }
            if (this.meta[META.length] === this.meta[META.maxSize])
                throw new RangeError('SharedMap is full');
            /* Copy the element into place, chaining when needed */
            let i;
            for (i = 0; i < key.length; i++)
                this.keysData[pos * this.meta[META.keySize] + i] = key.charCodeAt(i);
            this.keysData[pos * this.meta[META.keySize] + i] = 0;
            for (i = 0; i < value.length; i++)
                this.valuesData[pos * this.meta[META.objSize] + i] = value.charCodeAt(i);
            this.valuesData[pos * this.meta[META.objSize] + i] = 0;
            this.chaining[pos] = UINT32_UNDEFINED;
            /* Use Atomics to increase the length, we do not hold an exclusive lock here */
            Atomics.add(this.meta, META.length, 1);
            if (toChain !== undefined) {
                this.chaining[toChain] = pos;
                exclusive || this.unlockLine(toChain);
                toChain = undefined;
            }
            exclusive || this.unlockLine(slidingLock);
        } catch (e) {
            if (!exclusive) {
                this.unlockLine(slidingLock);
                if (toChain !== undefined)
                    this.unlockLine(toChain);
            }
            throw e;
        }
    }

    set(key, value) {
        if (typeof key !== 'string' || key.length === 0)
            throw new TypeError(`SharedMap keys must be non-emptry strings, invalid key ${key}`);
        if (typeof value === 'number')
            value = value.toString();
        if (typeof value !== 'string')
            throw new TypeError('SharedMap can contain only strings and numbers which will be converted to strings');
        if (key.length > this.meta[META.keySize] << 1)
            throw new RangeError(`SharedMap key ${key} does not fit in ${this.meta[META.keySize] << 1} bytes, ${this.meta[META.keySize] << 1} UTF-16 code points`);
        if (value.length > this.meta[META.objSize] << 1)
            throw new RangeError(`SharedMap value ${value} does not fit in ${this.meta[META.objSize] << 1} bytes, ${this.meta[META.objSize] << 1} UTF-16 code points`);

        this.stats.set++;
        this.lockMapShared();
        try {
            this._set(key, value, false);
            this.unlockMapShared();
        } catch (e) {
            this.unlockMapShared();
            if (e instanceof Deadlock) {
                this.lockMapExclusive();
                this.stats.deadlock++;
                try {
                    this._set(key, value, true);
                    this.unlockMapExclusive();
                } catch (e) {
                    this.unlockMapExclusive();
                    throw e;
                }
            } else
                throw e;
        }
    }

    _find(key, exclusive) {
        let slidingLock;
        try {
            /* Hash */
            let pos = this._hash(key);
            let previous = UINT32_UNDEFINED;
            this.stats.get++;
            exclusive || (slidingLock = this.lockLine(pos));
            /* Loop through the bucket chaining */
            while (pos !== UINT32_UNDEFINED && this.keysData[pos * this.meta[META.keySize]] !== 0) {
                if (this._match(key, pos)) {
                    return { pos, previous };
                }
                previous = pos;
                pos = this.chaining[pos];
                if (pos !== UINT32_UNDEFINED && !exclusive)
                    slidingLock = this.lockLineSliding(slidingLock, pos);
            }
            exclusive || this.unlockLine(slidingLock);
            return undefined;
        } catch (e) {
            exclusive || this.unlockLine(slidingLock);
            throw e;
        }
    }

    get(key) {
        let pos, val;
        this.lockMapShared();
        try {
            pos = this._find(key, false);
            if (pos !== undefined) {
                val = this._decodeValue(pos.pos);
                this.unlockLine(pos.pos);
            }
            this.unlockMapShared();
        } catch (e) {
            this.unlockMapShared();
            if (e instanceof Deadlock) {
                this.lockMapExclusive();
                this.stats.deadlock++;
                try {
                    pos = this._find(key, true);
                    if (pos !== undefined) {
                        val = this._decodeValue(pos.pos);
                    }
                    this.unlockMapExclusive();
                } catch (e) {
                    this.unlockMapExclusive();
                    throw e;
                }
            } else
                throw e;
        }
        return val;
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    _hash(s) {
        if (typeof s.hash === 'function')
            return s.hash(s) % this.meta[META.maxSize];
        if (typeof s.hash === 'number')
            return s.hash % this.meta[META.maxSize];
        else
            return _hash(s) % this.meta[META.maxSize];
    }

    delete(key) {
        /* delete is slow */
        let find;
        try {
            this.lockMapExclusive();
            find = this._find(key, true);
        } catch (e) {
            this.unlockMapExclusive();
            throw e;
        }
        if (find === undefined) {
            this.unlockMapExclusive();
            throw RangeError(`SharedMap does not contain key ${key}`);
        }
        this.stats.delete++;
        const { pos, previous } = find;
        const next = this.chaining[pos];
        this.keysData[pos * this.meta[META.keySize]] = 0;
        if (previous !== UINT32_UNDEFINED)
            this.chaining[previous] = UINT32_UNDEFINED;
        this.meta[META.length]--;
        if (next === UINT32_UNDEFINED) {
            /* There was no further chaining, just delete this element */
            /* and unchain it from the previous */
            this.unlockMapExclusive();
            return;
        }
        /* Full rechaining */
        /* Some slight optimization avoiding copying some elements around
         * is possible, but the O(n) complexity is not
         */
        this.stats.rechains++;
        let el = next;
        let chain = [];
        while (el !== UINT32_UNDEFINED) {
            chain.push({ key: this._decodeKey(el), value: this._decodeValue(el) });
            this.keysData[el * this.meta[META.keySize]] = 0;
            this.meta[META.length]--;
            el = this.chaining[el];
        }
        for (el of chain) {
            this._set(el.key, el.value, true);
        }
        this.unlockMapExclusive();
    }

    *keys() {
        for (let pos = 0; pos < this.meta[META.maxSize]; pos++) {
            this.lockMapShared();
            this.lockLine(pos);
            if (this.keysData[pos * this.meta[META.keySize]] !== 0) {
                const k = this._decodeKey(pos);
                this.unlockLine(pos);
                this.unlockMapShared();
                yield k;
            } else {
                this.unlockLine(pos);
                this.unlockMapShared();
            }
        }
    }

    clear() {
        this.lockMapExclusive();
        this.keysData.fill(0);
        this.valuesData.fill(0);
        this.meta[META.length] = 0;
        this.unlockMapExclusive();
    }
}

module.exports = SharedMap;
