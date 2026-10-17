#include "ocio.h"

#ifdef RHAP_OCIO
#include <OpenColorIO/OpenColorIO.h>
namespace OCIO = OCIO_NAMESPACE;
#endif

namespace rhap::ocio {

#ifdef RHAP_OCIO
namespace {
OCIO::ConstConfigRcPtr load(const std::string& path) { return OCIO::Config::CreateFromFile(path.empty() ? defaultConfig() : path.c_str()); }

/** sample a processor on an n³ grid of inputs in [0, 1] (red fastest, as .cube) */
void bake(const OCIO::ConstCPUProcessorRcPtr& cpu, int n, color::Lut3D& out) {
  out.size = n;
  out.domainMin = {0, 0, 0};
  out.domainMax = {1, 1, 1};
  out.rgb.resize(size_t(n) * n * n * 3);
  for (int b = 0; b < n; ++b)
    for (int g = 0; g < n; ++g)
      for (int r = 0; r < n; ++r) {
        float px[3] = {float(r) / (n - 1), float(g) / (n - 1), float(b) / (n - 1)};
        cpu->applyRGB(px);
        size_t i = (size_t(b) * n * n + size_t(g) * n + size_t(r)) * 3;
        out.rgb[i] = px[0];
        out.rgb[i + 1] = px[1];
        out.rgb[i + 2] = px[2];
      }
}
}  // namespace
#endif

bool available() {
#ifdef RHAP_OCIO
  return true;
#else
  return false;
#endif
}

const char* defaultConfig() { return "ocio://studio-config-latest"; }

std::vector<std::string> displays(const std::string& config) {
  std::vector<std::string> v;
#ifdef RHAP_OCIO
  try {
    auto c = load(config);
    for (int i = 0; i < c->getNumDisplays(); ++i) v.push_back(c->getDisplay(i));
  } catch (...) {
  }
#endif
  (void)config;
  return v;
}

std::vector<std::string> views(const std::string& config, const std::string& display) {
  std::vector<std::string> v;
#ifdef RHAP_OCIO
  try {
    auto c = load(config);
    for (int i = 0; i < c->getNumViews(display.c_str()); ++i) v.push_back(c->getView(display.c_str(), i));
  } catch (...) {
  }
#endif
  (void)config;
  (void)display;
  return v;
}

std::vector<std::string> inputSpaces(const std::string& config) {
  std::vector<std::string> v;
#ifdef RHAP_OCIO
  try {
    auto c = load(config);
    for (int i = 0; i < c->getNumColorSpaces(); ++i) v.push_back(c->getColorSpaceNameByIndex(i));
  } catch (...) {
  }
#endif
  (void)config;
  return v;
}

std::string bakeOutput(const std::string& config, const std::string& display, const std::string& view, int n, color::Lut3D& out) {
#ifdef RHAP_OCIO
  try {
    auto c = load(config);
    auto t = OCIO::DisplayViewTransform::Create();
    t->setSrc("ACEScct");
    t->setDisplay(display.c_str());
    t->setView(view.c_str());
    bake(c->getProcessor(t)->getDefaultCPUProcessor(), n, out);
    return {};
  } catch (const std::exception& e) {
    return std::string("OCIO: ") + e.what();
  }
#else
  (void)config, (void)display, (void)view, (void)n, (void)out;
  return "this build has no OpenColorIO";
#endif
}

std::string bakeInput(const std::string& config, const std::string& space, int n, color::Lut3D& out) {
#ifdef RHAP_OCIO
  try {
    auto c = load(config);
    bake(c->getProcessor(space.c_str(), "ACEScct")->getDefaultCPUProcessor(), n, out);
    return {};
  } catch (const std::exception& e) {
    return std::string("OCIO: ") + e.what();
  }
#else
  (void)config, (void)space, (void)n, (void)out;
  return "this build has no OpenColorIO";
#endif
}

std::string applyOutput(const std::string& config, const std::string& display, const std::string& view, float rgb[3]) {
#ifdef RHAP_OCIO
  try {
    auto c = load(config);
    auto t = OCIO::DisplayViewTransform::Create();
    t->setSrc("ACEScg");
    t->setDisplay(display.c_str());
    t->setView(view.c_str());
    c->getProcessor(t)->getDefaultCPUProcessor()->applyRGB(rgb);
    return {};
  } catch (const std::exception& e) {
    return std::string("OCIO: ") + e.what();
  }
#else
  (void)config, (void)display, (void)view, (void)rgb;
  return "this build has no OpenColorIO";
#endif
}

std::string applyInput(const std::string& config, const std::string& space, float rgb[3]) {
#ifdef RHAP_OCIO
  try {
    load(config)->getProcessor(space.c_str(), "ACEScg")->getDefaultCPUProcessor()->applyRGB(rgb);
    return {};
  } catch (const std::exception& e) {
    return std::string("OCIO: ") + e.what();
  }
#else
  (void)config, (void)space, (void)rgb;
  return "this build has no OpenColorIO";
#endif
}

}  // namespace rhap::ocio
