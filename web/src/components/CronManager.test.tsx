// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listCronJobs: vi.fn(),
    createCronJob: vi.fn(),
    updateCronJob: vi.fn(),
    deleteCronJob: vi.fn(),
    toggleCronJob: vi.fn(),
    runCronJob: vi.fn(),
    getBackendModels: vi.fn(),
  },
}));

vi.mock("../api.js", () => ({ api: mockApi }));

vi.mock("./FolderPicker.js", () => ({
  FolderPicker: () => <div data-testid="folder-picker" />,
}));

import { CronManager } from "./CronManager.js";

async function openCreateForm() {
  render(<CronManager embedded />);
  await screen.findByText("No scheduled tasks yet.");
  fireEvent.click(screen.getByRole("button", { name: /new task/i }));
}

describe("CronManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listCronJobs.mockResolvedValue([]);
    mockApi.getBackendModels.mockResolvedValue([]);
  });

  it("renders the empty state", async () => {
    render(<CronManager embedded />);

    expect(await screen.findByText("No scheduled tasks yet.")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<CronManager embedded />);
    await screen.findByText("No scheduled tasks yet.");

    expect(await axe(container)).toHaveNoViolations();
  });

  it("toggles the create form", async () => {
    await openCreateForm();

    expect(screen.getByPlaceholderText(/task name/i)).toBeInTheDocument();
  });

  // The form used to fetch models for codex only, so a Claude task always fell back to
  // the first hardcoded entry rather than the model this machine actually runs.
  it("fetches models for the claude backend", async () => {
    mockApi.getBackendModels.mockResolvedValue([
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "claude-opus-4-6", label: "Opus 4.6" },
    ]);

    await openCreateForm();

    await waitFor(() => {
      expect(mockApi.getBackendModels).toHaveBeenCalledWith("claude");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sonnet 4\.6/i })).toBeInTheDocument();
    });
  });

  it("keeps the hardcoded models when the fetch fails", async () => {
    mockApi.getBackendModels.mockRejectedValue(new Error("offline"));

    await openCreateForm();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /opus 4\.6/i })).toBeInTheDocument();
    });
  });
});
