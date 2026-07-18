const KEY = 'delegate-rest-token'
export const getToken = () => localStorage.getItem(KEY)
export const setToken = (t) => localStorage.setItem(KEY, t)
export const clearToken = () => localStorage.removeItem(KEY)
