import { useConnectionStore } from "../stores/connection";
import { useTRPC } from "../trpc";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

export function useApiHealth() {
  const { setConnected } = useConnectionStore();
  const trpc = useTRPC();

  const pingQuery = useQuery(
    trpc.system.ping.queryOptions(undefined, {
      refetchInterval: 10000,
      retry: 0,
    })
  );

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
