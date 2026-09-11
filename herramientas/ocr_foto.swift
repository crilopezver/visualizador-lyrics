// OCR de una foto de hoja de acordes con Vision (macOS, sin instalar nada).
// Uso: ocr_foto <imagen> → JSON por línea: {"t": texto, "x": 0-1, "y": 0-1 (desde arriba), "w": ancho 0-1, "h": alto 0-1}
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("uso: ocr_foto <imagen>\n".data(using: .utf8)!); exit(1)
}
let req = VNRecognizeTextRequest { r, e in
  guard let obs = r.results as? [VNRecognizedTextObservation] else { return }
  var salida: [[String: Any]] = []
  for o in obs {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox // origen abajo-izquierda, normalizado
    salida.append(["t": c.string, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height, "conf": c.confidence])
  }
  let data = try! JSONSerialization.data(withJSONObject: salida, options: [])
  print(String(data: data, encoding: .utf8)!)
}
req.recognitionLevel = .accurate
req.recognitionLanguages = ["es-ES", "en-US"]
req.usesLanguageCorrection = false // no "corregir" acordes como palabras
try! VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
