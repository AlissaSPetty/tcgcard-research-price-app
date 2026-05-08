import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { get, set, del } from "idb-keyval";

const CACHE_KEY = "listing-admin-react-query-cache-v1";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 1000 * 60 * 60 * 24,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: async (key: string) => {
      const v = await get<string>(`${CACHE_KEY}:${key}`);
      return v ?? null;
    },
    setItem: async (key: string, value: string) => {
      await set(`${CACHE_KEY}:${key}`, value);
    },
    removeItem: async (key: string) => {
      await del(`${CACHE_KEY}:${key}`);
    },
  },
});
