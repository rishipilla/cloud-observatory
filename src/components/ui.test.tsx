import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Badge, Button, Card, EmptyState, LoadingState } from "./ui";

describe("dashboard UI primitives", () => {
  it("renders button state and invokes its handler", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Refresh</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders card and badge content", () => {
    render(<Card aria-label="Service card"><Badge>Operational</Badge></Card>);

    expect(screen.getByLabelText("Service card")).toHaveTextContent("Operational");
  });

  it("exposes loading and empty feedback to assistive technology", () => {
    render(<><LoadingState label="Loading services" /><EmptyState title="No services">Add one to begin.</EmptyState></>);

    expect(screen.getByText("Loading services")).toBeInTheDocument();
    expect(screen.getByText("No services")).toBeInTheDocument();
    expect(screen.getByText("Add one to begin.")).toBeInTheDocument();
  });
});
