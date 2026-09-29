import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DeicticFeaturesExplainer from "../components/UI/DeicticFeaturesExplainer";

describe("DeicticFeaturesExplainer", () => {
  it("renders the explainer title", () => {
    render(<DeicticFeaturesExplainer onClose={() => {}} />);
    expect(screen.getByText("Deictic Features")).toBeInTheDocument();
  });
});
