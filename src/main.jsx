import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Kroft from "./Kroft.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Kroft />
  </StrictMode>
);
