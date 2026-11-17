// Local single-image recognition evidence only; no factual verification or network access.
import Foundation
import Vision
import ImageIO

struct Failure: Error { let message: String }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failure(message: message) }
}
struct Box: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Observation: Codable { let page: Int; let text: String; let confidence: Double; let boundingBox: Box }
struct Evidence: Codable {
    let schema: String; let width: Int; let height: Int; let revision: Int
    let osVersion: String; let languages: [String]; let observations: [Observation]
}
func run() throws {
    let args = CommandLine.arguments
    try require(args.count == 4, "usage: vision input.png|jpg output.json output.txt")
    let paths = args.dropFirst().map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath() }
    try require(Set(paths.map { $0.path }).count == 3, "paths must be distinct")
    let input = paths[0], jsonPath = paths[1], textPath = paths[2]
    // Never replace an existing artifact, including hard-linked input files.
    try require(!FileManager.default.fileExists(atPath: jsonPath.path) && !FileManager.default.fileExists(atPath: textPath.path), "outputs must not exist")
    let attributes = try FileManager.default.attributesOfItem(atPath: input.path)
    try require(attributes[.type] as? FileAttributeType == .typeRegular, "input must be regular file")
    let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
    try require(size > 0 && size <= 25 * 1024 * 1024, "input byte budget exceeded")
    let data = try Data(contentsOf: input)
    try require(data.count <= 25 * 1024 * 1024, "input byte budget exceeded")
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let kind = CGImageSourceGetType(source) as String? else { throw Failure(message: "invalid image") }
    try require(kind == "public.png" || kind == "public.jpeg", "only PNG/JPEG supported")
    try require(CGImageSourceGetCount(source) == 1, "multiple frames unsupported")
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw Failure(message: "missing dimensions") }
    try require(width > 0 && height > 0 && width <= 20_000 && height <= 20_000 && width * height <= 40_000_000, "pixel budget exceeded")
    if let orientation = properties[kCGImagePropertyOrientation] {
        try require((orientation as? NSNumber)?.intValue == 1, "non-upright orientation unsupported")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure(message: "image decoding failed") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
    let results = request.results ?? []
    try require(results.count <= 10_000, "observation budget exceeded")
    let observations = try results.map { result -> Observation in
        guard let candidate = result.topCandidates(1).first else { throw Failure(message: "missing candidate") }
        let rect = result.boundingBox
        let x = Double(rect.minX), y = 1 - Double(rect.maxY)
        let w = Double(rect.width), h = Double(rect.height), confidence = Double(candidate.confidence)
        try require([x, y, w, h, confidence].allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 } && w > 0 && h > 0 && x + w <= 1 && y + h <= 1, "invalid observation bounds")
        try require(!candidate.string.isEmpty && !candidate.string.contains("\0"), "invalid recognition text")
        return Observation(page: 1, text: candidate.string, confidence: confidence, boundingBox: Box(x: x, y: y, width: w, height: h))
    }
    let plainText = observations.map { $0.text }.joined(separator: "\n")
    try require(plainText.utf8.count <= 8 * 1024 * 1024, "text budget exceeded")
    let evidence = Evidence(schema: "xuan.apple-vision-ocr/1", width: width, height: height, revision: request.revision,
                            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                            languages: request.recognitionLanguages, observations: observations)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let json = try encoder.encode(evidence)
    try require(json.count <= 8 * 1024 * 1024, "JSON budget exceeded")
    // Artifacts are consumed only after successful process completion and host validation.
    try Data(plainText.utf8).write(to: textPath, options: .withoutOverwriting)
    try json.write(to: jsonPath, options: .withoutOverwriting)
}
do { try run() } catch {
    FileHandle.standardError.write(Data("OCR_VISION_FAILED: \(error)\n".utf8))
    exit(1)
}
