import AppKit
import Foundation
import Vision

struct OCRLine: Codable {
  let text: String
  let confidence: Float
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

enum OCRFrameError: Error {
  case missingArgument
  case unreadableImage(String)
  case missingCGImage(String)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  throw OCRFrameError.missingArgument
}

let path = arguments[1]
let url = URL(fileURLWithPath: path)

guard let image = NSImage(contentsOf: url) else {
  throw OCRFrameError.unreadableImage(path)
}

var proposedRect = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
  throw OCRFrameError.missingCGImage(path)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

let lines = (request.results ?? [])
  .compactMap { observation -> OCRLine? in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }

    let box = observation.boundingBox
    return OCRLine(
      text: candidate.string,
      confidence: candidate.confidence,
      x: box.origin.x,
      y: box.origin.y,
      width: box.size.width,
      height: box.size.height,
    )
  }
  .sorted { lhs, rhs in
    if abs(lhs.y - rhs.y) > 0.02 {
      return lhs.y > rhs.y
    }
    return lhs.x < rhs.x
  }

let json = try JSONEncoder().encode(lines)
print(String(data: json, encoding: .utf8)!)
