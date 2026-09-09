CACHE_TTL_SECONDS = 300


def cache_get(store, key):
    return store.get(key)


def cache_put(store, key, value):
    store[key] = value
