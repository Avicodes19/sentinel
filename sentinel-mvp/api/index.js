import handler from "../server/index.js";

export default async function (req, res) {
  return handler(req, res);
}
