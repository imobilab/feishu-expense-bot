#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc != 2) {
            fprintf(stderr, "usage: vision-ocr <image-path>\n");
            return 2;
        }
        NSString *imagePath = [NSString stringWithUTF8String:argv[1]];
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        request.recognitionLanguages = @[@"zh-Hans", @"en-US"];

        NSURL *imageURL = [NSURL fileURLWithPath:imagePath];
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:imageURL options:@{}];
        NSError *error = nil;
        if (![handler performRequests:@[request] error:&error]) {
            fprintf(stderr, "OCR failed: %s\n", error.localizedDescription.UTF8String);
            return 4;
        }
        for (VNRecognizedTextObservation *observation in request.results) {
            VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
            if (candidate) printf("%s\n", candidate.string.UTF8String);
        }
    }
    return 0;
}
