import { render } from "preact";
import { App } from "./app";
import "./ui/styles.css";

Office.onReady(() => render(<App />, document.getElementById("root")!));
