import { useConnectionStore } from "../stores/connection";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { authFetch } from "../lib/auth";

export function useApiHealth() {
  const { setConnected } = useConnectionStore();
  const pingQuery = useQuery({
    queryKey: ["health-check"],
    queryFn: async () => {
      const response = await authFetch("/api/health", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Health check failed");
      }
      return await response.json();
    },
    refetchInterval: 10000,
    retry: 0,
  });

  useEffect(() => {
    if (pingQuery.isSuccess) {
      setConnected("api", true);
    }
  }, [pingQuery.isSuccess, pingQuery.dataUpdatedAt, setConnected]);

  useEffect(() => {
    if (pingQuery.isError || pingQuery.isRefetchError) {
      setConnected("api", false);
    }
  }, [
    pingQuery.isError,
    pingQuery.isRefetchError,
    pingQuery.errorUpdatedAt,
    setConnected,
  ]);
}
