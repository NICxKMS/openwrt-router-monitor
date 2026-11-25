include $(TOPDIR)/rules.mk

PKG_VERSION:=1.0.0
PKG_RELEASE:=2

LUCI_TITLE:=LuCI support for Nicx router telemetry
LUCI_DEPENDS:=+luci-base +nicx-telemetry
LUCI_PKGARCH:=all
PKG_LICENSE:=MIT

# Works when copied into OpenWrt package/ as well as the LuCI feed.
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
