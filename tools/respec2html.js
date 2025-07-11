#!/usr/bin/env node
import { readFile, writeFile } from "fs/promises";
import colors from "colors";
import { fileURLToPath } from "url";
import finalhandler from "finalhandler";
import http from "http";
import { marked } from "marked";
import path from "path";
import sade from "sade";
import serveStatic from "serve-static";
import { toHTML } from "./respecDocWriter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class Renderer extends marked.Renderer {
  strong(text) {
    return colors.bold(text);
  }
  em(text) {
    return colors.italic(text);
  }
  codespan(text) {
    return colors.underline(unescape(text));
  }
  paragraph(text) {
    return unescape(text);
  }
  link(href, _title, text) {
    return `[${text}](${colors.blue.dim.underline(href)})`;
  }
  list(body, _orderered) {
    return `\n${body}`;
  }
  listitem(text) {
    return `* ${text}\n`;
  }
}

class Logger {
  /** @param {boolean} verbose */
  constructor(verbose) {
    this.verbose = verbose;
  }

  /**
   * @param {string} message
   * @param {number} timeRemaining
   */
  info(message, timeRemaining) {
    if (!this.verbose) return;
    const header = colors.dim.bgWhite.black.bold("[INFO]");
    const time = colors.dim(`[Timeout: ${timeRemaining}ms]`);
    console.error(header, time, message);
  }

  /**
   * @typedef {import("./respecDocWriter.js").RsError} RsError
   * @param {RsError} rsError
   */
  error(rsError) {
    const header = colors.bgRed.white.bold("[ERROR]");
    const message = colors.red(this._formatMarkdown(rsError.message));
    console.error(header, message);
    if (rsError.plugin) {
      this._printDetails(rsError);
    }
  }

  /** @param {RsError} rsError */
  warn(rsError) {
    const header = colors.bgYellow.black.bold("[WARNING]");
    const message = colors.yellow(this._formatMarkdown(rsError.message));
    console.error(header, message);
    if (rsError.plugin) {
      this._printDetails(rsError);
    }
  }

  /** @param {Error | string} error */
  fatal(error) {
    const header = colors.bgRed.white.bold("[FATAL]");
    const message = colors.red(error.stack || error);
    console.error(header, message);
  }

  _formatMarkdown(str) {
    if (typeof str !== "string") return str;
    return marked(str, { smartypants: true, renderer: new Renderer() });
  }

  /** @param {import("./respecDocWriter").ReSpecError} rsError */
  _printDetails(rsError) {
    const shouldPrintStacktrace = this._shouldPrintStacktrace(rsError);
    const print = (title, value) => {
      if (!value) return;
      const longestTitle = shouldPrintStacktrace ? "Stacktrace" : "Plugin";
      const padWidth = longestTitle.length + 1;
      const paddedTitle = `${title}:`.padStart(padWidth);
      console.error(" ", colors.bold(paddedTitle), this._formatMarkdown(value));
    };
    print("Count", rsError.elements && String(rsError.elements.length));
    print("Plugin", rsError.plugin);
    print("Hint", rsError.hint);
    if (shouldPrintStacktrace) {
      let stacktrace = `${rsError.stack}`;
      if (rsError.cause) {
        stacktrace += `\n    ${colors.bold("Caused by:")} ${rsError.cause.stack.split("\n").join("\n   ")}`;
      }
      print("Stacktrace", stacktrace);
    }
  }

  _shouldPrintStacktrace(rsError) {
    return (
      this.verbose &&
      !!rsError.stack &&
      (!!rsError.cause?.stack || rsError.plugin === "unknown")
    );
  }
}

class StaticServer {
  /**
   * @param {number} port
   * @param {string} source
   */
  constructor(port, source) {
    if (path.isAbsolute(source) || /^(\w+:\/\/)/.test(source.trim())) {
      const msg = `Invalid path for use with --localhost. Only relative paths allowed.`;
      const hint =
        "Please ensure your ReSpec document and its local resources" +
        " (e.g., data-includes) are accessible from the current working directory.";
      throw new Error(`${msg} ${hint}`);
    }

    if (port && isNaN(parseInt(port, 10))) {
      throw new Error("Invalid port number.");
    }

    this.port = port;
    this.source = source;

    const serve = serveStatic(process.cwd());
    this.server = http.createServer((req, res) => {
      serve(req, res, finalhandler(req, res));
    });
  }

  get url() {
    return new URL(this.source, `http://localhost:${this.port}/`);
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.listen(this.port, resolve);
      this.server.on("error", reject);
    });
  }

  async stop() {
    await new Promise(resolve => this.server.close(resolve));
  }
}

const cli = sade("respec [source] [destination]", true)
  .describe("Converts a ReSpec source file to HTML and writes to destination.")
  .example(`input.html output.html ${colors.dim("# Output to a file.")}`)
  .example(
    `http://example.com/spec.html stdout ${colors.dim("# Output to stdout.")}`
  )
  .example(
    `http://example.com/spec.html output.html -e -w ${colors.dim(
      "# Halt on errors or warning."
    )}`
  )
  .example("--src http://example.com/spec.html --out spec.html")
  .example(
    `--localhost index.html out.html ${colors.dim(
      "# Generate file using a local web server."
    )}`
  );

cli
  // For backward compatibility
  .option("-s, --src", "URL to ReSpec source file.")
  // For backward compatibility
  .option("-o, --out", "Path to output file.")
  .option(
    "-t, --timeout",
    "How long to wait before timing out (in seconds).",
    10
  )
  .option(
    "--use-local",
    "Use locally installed ReSpec instead of the one in document.",
    false
  )
  .option("-e, --haltonerror", "Abort if the spec has any errors.", false)
  .option(
    "-w, --haltonwarn",
    "Abort if ReSpec generates warnings (or errors).",
    false
  )
  .option(
    "--sandbox",
    "Disable Chromium sandboxing if needed, with --no-sandbox.",
    true
  )
  .option("--disable-sandbox", "Alias of --no-sandbox.", false)
  .option("--devtools", "Enable debugging and show Chrome's DevTools.", false)
  .option("--verbose", "Log processing status to stdout.", false)
  .option("--localhost", "Spin up a local server to perform processing.", false)
  .option("--port", "Port override for --localhost.", 3000);

cli.action(async (source, destination, opts) => {
  source = source || opts.src;
  destination = destination || opts.out;
  const log = new Logger(opts.verbose);

  if (!source) {
    log.fatal("A source is required.");
    cli.help();
    process.exit(1);
  }

  if (opts["disable-sandbox"]) {
    opts.sandbox = false;
    delete opts["disable-sandbox"];
  }

  try {
    await run(source, destination, opts, log);
    process.exit(0);
  } catch (error) {
    log.fatal(error);
    process.exit(1);
  }
});

// https://github.com/lukeed/sade/issues/28#issuecomment-516104013
cli._version = async () => {
  const packageJson = path.join(__dirname, "..", "package.json");
  const { version } = JSON.parse(await readFile(packageJson));
  console.log(version);
};

cli.parse(process.argv, {
  unknown(flag) {
    new Logger().fatal(`Unknown option: ${flag}`);
    process.exit(1);
  },
});

/**
 * @param {string} source
 * @param {string|undefined} destination
 * @param {Record<string, string|number|boolean>} options
 * @param {Logger} log
 */
async function run(source, destination, options, log) {
  let staticServer;
  if (options.localhost) {
    staticServer = new StaticServer(options.port, source);
    await staticServer.start();
  }
  const src = options.localhost
    ? staticServer.url.href
    : new URL(source, `file://${process.cwd()}/`).href;
  log.info(`Processing resource: ${src} ...`, options.timeout * 1000);

  const { html, errors, warnings } = await toHTML(src, {
    timeout: options.timeout * 1000,
    useLocal: options["use-local"],
    onError: log.error.bind(log),
    onWarning: log.warn.bind(log),
    onProgress: log.info.bind(log),
    disableSandbox: !options.sandbox,
    devtools: options.devtools,
  });

  const exitOnError = errors.length && options.haltonerror;
  const exitOnWarning =
    (warnings.length || errors.length) && options.haltonwarn;
  if (exitOnError || exitOnWarning) {
    throw new Error(
      `${exitOnError ? "Errors" : "Warnings"} found during processing.`
    );
  }

  // Patch to address Mermaid issue https://github.com/mermaid-js/mermaid/issues/1766.
  let reduceHTML = html;
  let svgSafeHTML = "";

  // Keep going until no more SVG tags.
  while (reduceHTML !== "") {
    const svgStart = reduceHTML.search(/<svg( [\S\s]*?|)>/);
    if (svgStart !== -1) {
      svgSafeHTML += reduceHTML.slice(0, svgStart);
      reduceHTML = reduceHTML.slice(svgStart);

      let svgEnd = reduceHTML.search("</svg>");

      // SVG closing tag should exist, but check anyway.
      if (svgEnd !== -1) {
        svgEnd += 6;

        // Replace all <br> tags within SVG with <br />.
        svgSafeHTML += reduceHTML.slice(0, svgEnd).replace(/<br>/g, "<br />");
        reduceHTML = reduceHTML.slice(svgEnd);
      } else {
        svgSafeHTML += reduceHTML;
        reduceHTML = "";
      }
    } else {
      svgSafeHTML += reduceHTML;
      reduceHTML = "";
    }
  }

  await write(destination, svgSafeHTML);

  if (staticServer) await staticServer.stop();
}

/**
 * @param {string | "stdout" | null | "" | undefined} destination
 * @param {string} html
 */
async function write(destination, html) {
  switch (destination) {
    case "":
    case null:
    case undefined:
      break;
    case "stdout":
      process.stdout.write(html);
      break;
    default: {
      const newFilePath = path.isAbsolute(destination)
        ? destination
        : path.resolve(process.cwd(), destination);
      await writeFile(newFilePath, html, "utf-8");
    }
  }
}

/**
 * From https://gist.github.com/WebReflection/df05641bd04954f6d366
 * @param {string} str
 */
function unescape(str) {
  const re = /&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34);/g;
  const unescaped = {
    "&amp;": "&",
    "&#38;": "&",
    "&lt;": "<",
    "&#60;": "<",
    "&gt;": ">",
    "&#62;": ">",
    "&apos;": "'",
    "&#39;": "'",
    "&quot;": '"',
    "&#34;": '"',
  };
  return str.replace(re, m => unescaped[m]);
}
