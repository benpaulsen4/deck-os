import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../apps/templates/index";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Link: (props: { children: unknown; to?: string; params?: { templateId?: string } }) => (
      <a data-to={props.to} data-template-id={props.params?.templateId}>
        {props.children as string}
      </a>
    ),
  };
});

const { listQueryOptionsSpy, state } = vi.hoisted(() => ({
  listQueryOptionsSpy: vi.fn((input: unknown) => ({
    queryKey: ["templates.list", input],
  })),
  state: {
    data: { items: [], total: 0, categories: [] as string[] },
  },
}));

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    templates: {
      list: {
        queryOptions: listQueryOptionsSpy,
      },
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: state.data,
    isLoading: false,
  }),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

describe("templates storefront route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    state.data = { items: [], total: 0, categories: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows empty state and debounces query text", () => {
    const Component = Route.options.component;
    render(<Component />);
    expect(screen.getByText("NO TEMPLATES FOUND")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SEARCH"), { target: { value: " jelly " } });
    vi.advanceTimersByTime(260);
    expect(listQueryOptionsSpy).toHaveBeenCalled();
  });

  it("resets page to 1 on query and category changes", () => {
    state.data = {
      items: [{ id: "tpl-1", title: "App", description: "Desc", icon: "", categories: [] }],
      total: 100,
      categories: ["media"],
    };
    const Component = Route.options.component;
    render(<Component />);
    fireEvent.change(screen.getByLabelText("SEARCH"), { target: { value: "reset me" } });
    vi.advanceTimersByTime(260);
    const afterSearch = listQueryOptionsSpy.mock.calls.at(-1)?.[0] as {
      page?: number;
      category?: string;
    };
    expect(afterSearch.page).toBe(1);
    fireEvent.change(screen.getByLabelText("CATEGORY"), { target: { value: "media" } });
    const afterCategory = listQueryOptionsSpy.mock.calls.at(-1)?.[0] as {
      page?: number;
      category?: string;
    };
    expect(afterCategory.page).toBe(1);
    expect(afterCategory.category).toBe("media");
  });

  it("renders deploy links to /apps/templates/$templateId", () => {
    state.data = {
      items: [{ id: "tpl-99", title: "App", description: "Desc", icon: "", categories: [] }],
      total: 1,
      categories: [],
    };
    const Component = Route.options.component;
    const { container } = render(<Component />);
    const link = container.querySelector("[data-template-id='tpl-99']");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("data-to")).toBe("/apps/templates/$templateId");
  });
});
